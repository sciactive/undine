import zlib from 'node:zlib';
import { pipeline, Readable } from 'node:stream';
import type { Request } from 'express';
import xml2js from 'xml2js';
import contentType from 'content-type';
import splitn from '@sciactive/splitn';
import vary from 'vary';

import type {
  Adapter,
  AuthResponse,
  Lock,
  Options,
  Resource,
  User,
} from '../index.js';
import {
  BadRequestError,
  EncodingNotSupportedError,
  MediaTypeNotSupportedError,
  MethodNotSupportedError,
  UnauthorizedError,
} from '../index.js';

export class Method {
  adapter: Adapter;
  opts: Options;

  DEV = process.env.NODE_ENV !== 'production';

  xmlParser = new xml2js.Parser({
    xmlns: true,
  });
  xmlBuilder = new xml2js.Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    ...(this.DEV
      ? {
          renderOpts: {
            pretty: true,
          },
        }
      : {
          renderOpts: {
            indent: '',
            newline: '',
            pretty: false,
          },
        }),
  });

  constructor(adapter: Adapter, opts: Options) {
    this.adapter = adapter;
    this.opts = opts;
  }

  /**
   * You should reimplement this function in your class to handle the method.
   */
  async run(request: Request, _response: AuthResponse) {
    throw new MethodNotSupportedError(
      `${request.method} is not supported on this server.`
    );
  }

  /**
   * Check that the user is authorized to run the method.
   *
   * @param method This will be pulled from the request if not provided.
   * @param url This will be pulled from the request if not provided.
   */
  async checkAuthorization(
    request: Request,
    response: AuthResponse,
    method?: string,
    url?: URL
  ) {
    // If the adapter says it can handle the method, just handle the
    // authorization and error handling for it.
    if (
      !(await this.adapter.isAuthorized(
        url ||
          new URL(request.url, `${request.protocol}://${request.headers.host}`),
        method || request.method,
        request.baseUrl,
        response.locals.user
      ))
    ) {
      throw new UnauthorizedError('Unauthorized.');
    }
  }

  /**
   * Return the collection of which the given resource is an internal member.
   *
   * Returns `undefined` if the resource is the root of the WebDAV server.
   */
  async getParentResource(request: Request, resource: Resource) {
    const url = await resource.getCanonicalUrl(this.getRequestBaseUrl(request));

    const splitPath = url.pathname.replace(/(?:$|\/$)/, () => '').split('/');
    const newPath = splitPath
      .slice(0, -1)
      .join('/')
      .replace(/(?:$|\/$)/, () => '/');

    if (newPath === request.baseUrl.replace(/(?:$|\/$)/, () => '/')) {
      return undefined;
    }

    return await this.adapter.getResource(
      new URL(newPath, this.getRequestBaseUrl(request)),
      request.baseUrl
    );
  }

  async removeAndDeleteTimedOutLocks(locks: Lock[]) {
    const currentLocks: Lock[] = [];

    for (let lock of locks) {
      if (lock.date.getTime() + lock.timeout <= new Date().getTime()) {
        try {
          await lock.delete();
        } catch (e: any) {
          // Ignore errors deleting timed out locks.
        }
      } else {
        currentLocks.push(lock);
      }
    }

    return currentLocks;
  }

  async getCurrentResourceLocks(resource: Resource) {
    const locks = await resource.getLocks();
    return await this.removeAndDeleteTimedOutLocks(locks);
  }

  async getCurrentResourceLocksByUser(resource: Resource, user: User) {
    const locks = await resource.getLocksByUser(user);
    return await this.removeAndDeleteTimedOutLocks(locks);
  }

  private async getLocksGeneral(
    request: Request,
    resource: Resource,
    getLocks: (resource: Resource) => Promise<Lock[]>
  ) {
    const resourceLocks = await getLocks(resource);
    const locks: {
      all: Lock[];
      resource: Lock[];
      depthZero: Lock[];
      depthInfinity: Lock[];
    } = {
      all: [...resourceLocks],
      resource: resourceLocks,
      depthZero: [],
      depthInfinity: [],
    };

    let parent = await this.getParentResource(request, resource);
    let firstLevelParent = true;
    while (parent) {
      const parentLocks = await getLocks(parent);

      for (let lock of parentLocks) {
        if (lock.depth === 'infinity') {
          locks.depthInfinity.push(lock);
          locks.all.push(lock);
        } else if (firstLevelParent && lock.depth === '0') {
          locks.depthZero.push(lock);
          locks.all.push(lock);
        }
      }

      parent = await this.getParentResource(request, parent);
      firstLevelParent = false;
    }

    return locks;
  }

  async getLocks(request: Request, resource: Resource) {
    return await this.getLocksGeneral(
      request,
      resource,
      async (resource: Resource) =>
        (
          await this.getCurrentResourceLocks(resource)
        ).filter((lock) => !lock.provisional)
    );
  }

  async getLocksByUser(request: Request, resource: Resource, user: User) {
    return await this.getLocksGeneral(
      request,
      resource,
      async (resource: Resource) =>
        (
          await this.getCurrentResourceLocksByUser(resource, user)
        ).filter((lock) => !lock.provisional)
    );
  }

  async getProvisionalLocks(request: Request, resource: Resource) {
    return await this.getLocksGeneral(
      request,
      resource,
      async (resource: Resource) =>
        (
          await this.getCurrentResourceLocks(resource)
        ).filter((lock) => lock.provisional)
    );
  }

  /**
   * Check if the user has permission to modify the resource, taking into
   * account the set of locks they have submitted.
   *
   * Returns 0 if the user has no permissions to modify this resource or any
   * resource this one may contain. (Directly locked or depth infinity locked.)
   *
   * Returns 1 if this resource is within a collection and the user has no
   * permission to modify the mapping of the internal members of the collection,
   * but it can modify the contents of members. This means the user cannot
   * create, move, or delete the resource, but can change its contents. (Depth 0
   * locked.)
   *
   * Returns 2 if the user has full permissions to modify this resource (either
   * it is not locked or the user owns the lock and has provided it).
   *
   * Returns 3 if the user does not have full permission to modify this
   * resource, but does have permission to lock it with a shared lock. This is
   * only returned if `request.method === 'LOCK'`.
   *
   * @param request The request to check the lock permission for.
   * @param resource The resource to check.
   * @param user The user to check.
   */
  async getLockPermission(
    request: Request,
    resource: Resource,
    user: User
  ): Promise<0 | 1 | 2 | 3> {
    const locks = await this.getLocks(request, resource);
    const lockTokens = this.getRequestLockTockens(request);

    if (!locks.all.length) {
      return 2;
    }

    const userLocks = await this.getLocksByUser(request, resource, user);
    const lockTokenSet = new Set(lockTokens);

    if (userLocks.all.find((userLock) => lockTokenSet.has(userLock.token))) {
      // The user owns the lock and has submitted it.
      return 2;
    }

    if (request.method === 'LOCK') {
      let code: 0 | 3 = 0;

      for (let lock of locks.resource) {
        if (lock.scope === 'exclusive') {
          return 0;
        } else if (lock.scope === 'shared') {
          code = 3;
        }
      }

      for (let lock of locks.depthInfinity) {
        if (lock.scope === 'exclusive') {
          return 0;
        } else if (lock.scope === 'shared') {
          code = 3;
        }
      }

      for (let lock of locks.depthZero) {
        if (lock.scope === 'exclusive') {
          return 1;
        } else if (lock.scope === 'shared') {
          code = 3;
        }
      }

      return code;
    } else {
      if (locks.depthInfinity.length || locks.resource.length) {
        return 0;
      }

      if (locks.depthZero.length) {
        return 1;
      }

      return 0;
    }
  }

  /**
   * Extract the submitted lock tokens.
   *
   * Note that this is different than checking the conditional "If" header. That
   * must be done separately from checking submitted lock tokens.
   */
  getRequestLockTockens(request: Request) {
    const lockTokens: string[] = [];
    const ifHeader = request.get('If') || '';

    const matches = ifHeader.match(
      /<urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>/g
    );

    if (matches) {
      for (let match of matches) {
        lockTokens.push(match.slice(1, -1));
      }
    }

    return lockTokens;
  }

  chekIfHeader(request: Request, etag: string, lockTokens: string[]) {
    // TODO: process the if header list. (page 73)
    const ifHeader = request.get('If') || '';

    return true;
  }

  getRequestBaseUrl(request: Request) {
    return new URL(
      request.baseUrl,
      `${request.protocol}://${request.headers.host}`
    );
  }

  getRequestedEncoding(request: Request, response: AuthResponse) {
    const acceptEncoding =
      request.get('Accept-Encoding') || 'identity, *;q=0.5';
    const supported = ['gzip', 'deflate', 'br', 'identity'];
    const encodings: [string, number][] = acceptEncoding
      .split(',')
      .map((value) => value.trim().split(';'))
      .map((value) => [
        value[0],
        parseFloat(value[1]?.replace(/^q=/, '') || '1.0'),
      ]);
    encodings.sort((a, b) => b[1] - a[1]);
    let encoding = '';
    while (![...supported, 'x-gzip', '*'].includes(encoding)) {
      if (!encodings.length) {
        throw new EncodingNotSupportedError(
          'Requested content encoding is not supported.'
        );
      }
      encoding = encodings.splice(0, 1)[0][0];
    }
    if (encoding === '*') {
      // Pick the first encoding that's not listed in the header.
      encoding =
        supported.find(
          (check) => encodings.find(([check2]) => check === check2) == null
        ) || 'gzip';
    }
    response.locals.debug(`Requested encoding: ${encoding}.`);
    return encoding as 'gzip' | 'x-gzip' | 'deflate' | 'br' | 'identity';
  }

  getCacheControl(request: Request) {
    const cacheControlHeader = request.get('Cache-Control') || '*';
    const cacheControl: { [k: string]: number | true } = {};

    cacheControlHeader.split(',').forEach((directive) => {
      if (
        directive.startsWith('max-age=') ||
        directive.startsWith('s-maxage=') ||
        directive.startsWith('stale-while-revalidate=') ||
        directive.startsWith('stale-if-error=') ||
        directive.startsWith('max-stale=') ||
        directive.startsWith('min-fresh=')
      ) {
        const [name, value] = directive.split('=');
        cacheControl[name] = parseInt(value);
      } else {
        cacheControl[directive] = true;
      }
    });

    return cacheControl;
  }

  getRequestData(request: Request, response: AuthResponse) {
    const url = new URL(
      request.url,
      `${request.protocol}://${request.headers.host}`
    );
    const encoding = this.getRequestedEncoding(request, response);
    const cacheControl = this.getCacheControl(request);
    return { url, encoding, cacheControl };
  }

  getRequestDestination(request: Request) {
    const destinationHeader = request.get('Destination');

    let destination: URL | undefined = undefined;
    if (destinationHeader != null) {
      try {
        destination = new URL(destinationHeader);
      } catch (e: any) {
        throw new BadRequestError('Destination header must be a valid URI.');
      }
    }

    return destination;
  }

  async getBodyStream(request: Request, response: AuthResponse) {
    response.locals.debug('Getting body stream.');

    request.setTimeout(this.opts.timeout);

    request.on('timeout', () => {
      response.locals.debug(
        `Timed out after waiting ${this.opts.timeout / 1000} seconds for data.`
      );

      stream.destroy();
    });

    let stream: Readable = request;
    let encoding = request.get('Content-Encoding');
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        stream = pipeline(request, zlib.createGunzip(), (e: any) => {
          if (e) {
            throw new Error('Compression pipeline failed: ' + e);
          }
        });
        break;
      case 'deflate':
        stream = pipeline(request, zlib.createInflate(), (e: any) => {
          if (e) {
            throw new Error('Compression pipeline failed: ' + e);
          }
        });
        break;
      case 'br':
        stream = pipeline(request, zlib.createBrotliDecompress(), (e: any) => {
          if (e) {
            throw new Error('Compression pipeline failed: ' + e);
          }
        });
        break;
      case 'identity':
        break;
      default:
        if (encoding != null) {
          throw new MediaTypeNotSupportedError(
            'Provided content encoding is not supported.'
          );
        }
        break;
    }

    return stream;
  }

  async sendBodyContent(
    response: AuthResponse,
    content: string,
    encoding: 'gzip' | 'x-gzip' | 'deflate' | 'br' | 'identity'
  ) {
    vary(response, 'Accept-Encoding');

    // First, check cache-control.
    const cacheControl = response.getHeader('Cache-Control');
    const noTransform =
      typeof cacheControl === 'string' &&
      cacheControl.match(/(?:^|,)\s*?no-transform\s*?(?:,|$)/);

    if (!this.opts.compression || encoding === 'identity' || noTransform) {
      response.locals.debug(`Response encoding: identity`);
      const unencodedContent = Buffer.from(content, 'utf-8');
      response.set({
        'Content-Length': unencodedContent.byteLength,
      });
      response.send(unencodedContent);
    } else {
      response.locals.debug(`Response encoding: ${encoding}`);
      let transform: (content: Buffer) => Buffer = (content) => content;
      switch (encoding) {
        case 'gzip':
        case 'x-gzip':
          transform = (content) => zlib.gzipSync(content);
          break;
        case 'deflate':
          transform = (content) => zlib.deflateSync(content);
          break;
        case 'br':
          transform = (content) => zlib.brotliCompressSync(content);
          break;
      }
      const unencodedContent = Buffer.from(content, 'utf-8');
      const encodedContent = transform(unencodedContent);
      response.set({
        'Content-Encoding': encoding,
        'Content-Length': encodedContent.byteLength,
      });
      response.send(encodedContent);
    }
  }

  /**
   * Get the body of the request as an XML object from xml2js.
   *
   * If you call this function, it means that anything other than XML in the
   * body is an error.
   *
   * If the body is empty, it will return null.
   */
  async getBodyXML(request: Request, response: AuthResponse) {
    const stream = await this.getBodyStream(request, response);
    const contentTypeHeader = request.get('Content-Type');
    const contentLengthHeader = request.get('Content-Length');
    const transferEncoding = request.get('Transfer-Encoding');

    if (transferEncoding === 'chunked') {
      // TODO: transfer-encoding chunked.
      response.locals.debug('Request transfer encoding is chunked.');
    }

    if (contentTypeHeader == null && contentLengthHeader === '0') {
      return null;
    }

    // Be nice to clients who don't send a Content-Type header.
    const requestType = contentType.parse(
      contentTypeHeader || 'application/xml'
    );

    if (
      requestType.type !== 'text/xml' &&
      requestType.type !== 'application/xml'
    ) {
      throw new MediaTypeNotSupportedError(
        'Provided content type is not supported.'
      );
    }

    if (
      ![
        'ascii',
        'utf8',
        'utf-8',
        'utf16le',
        'ucs2',
        'ucs-2',
        'base64',
        'base64url',
        'latin1',
        'binary',
        'hex',
      ].includes(requestType?.parameters?.charset || 'utf-8')
    ) {
      throw new MediaTypeNotSupportedError(
        'Provided content charset is not supported.'
      );
    }

    const encoding: BufferEncoding = (requestType?.parameters?.charset ||
      'utf-8') as BufferEncoding;

    let xml = await new Promise<string>((resolve, reject) => {
      const buffers: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        buffers.push(chunk);
      });

      stream.on('end', () => {
        resolve(Buffer.concat(buffers).toString(encoding));
      });

      stream.on('error', (e: any) => {
        reject(e);
      });
    });

    if (xml.trim() === '') {
      return null;
    }

    return xml;
  }

  /**
   * Parse XML into a form that uses the DAV: namespace.
   *
   * Tags and attributes from other namespaces will have their namespace and the
   * string '%%' prepended to their name.
   */
  async parseXml(xml: string) {
    let parsed = await this.xmlParser.parseStringPromise(xml);
    let prefixes: { [k: string]: string } = {};

    const rewriteAttributes = (
      input: {
        [k: string]: {
          name: string;
          value: string;
          prefix: string;
          local: string;
          uri: string;
        };
      },
      namespace: string
    ): any => {
      const output: { [k: string]: string } = {};

      for (let name in input) {
        if (
          input[name].uri === 'http://www.w3.org/2000/xmlns/' ||
          input[name].uri === 'http://www.w3.org/XML/1998/namespace'
        ) {
          output[name] = input[name].value;
        } else if (
          input[name].uri === 'DAV:' ||
          (input[name].uri === '' && namespace === 'DAV:')
        ) {
          output[input[name].local] = input[name].value;
        } else {
          output[`${input[name].uri || namespace}%%${input[name].local}`] =
            input[name].value;
        }
      }

      return output;
    };

    const extractNamespaces = (input: {
      [k: string]: {
        name: string;
        value: string;
        prefix: string;
        local: string;
        uri: string;
      };
    }) => {
      const output: { [k: string]: string } = {};

      for (let name in input) {
        if (
          input[name].uri === 'http://www.w3.org/2000/xmlns/' &&
          input[name].local !== '' &&
          input[name].value !== 'DAV:'
        ) {
          output[input[name].local] = input[name].value;
        }
      }

      return output;
    };

    const recursivelyRewrite = (
      input: any,
      lang?: string,
      element = '',
      prefix: string = '',
      namespaces: { [k: string]: string } = {},
      includeLang = false
    ): any => {
      if (Array.isArray(input)) {
        return input.map((value) =>
          recursivelyRewrite(
            value,
            lang,
            element,
            prefix,
            namespaces,
            includeLang
          )
        );
      } else if (typeof input === 'object') {
        const output: { [k: string]: any } = {};
        // Remember the xml:lang attribute, as required by spec.
        let curLang = lang;
        let curNamespaces = { ...namespaces };

        if ('$' in input) {
          if ('xml:lang' in input.$) {
            curLang = input.$['xml:lang'].value as string;
          }

          output.$ = rewriteAttributes(input.$, input.$ns.uri);
          curNamespaces = {
            ...curNamespaces,
            ...extractNamespaces(input.$),
          };
        }

        if (curLang != null && includeLang) {
          output.$ = output.$ || {};
          output.$['xml:lang'] = curLang;
        }

        if (element.includes('%%') && prefix !== '') {
          const uri = element.split('%%', 1)[0];
          if (prefix in curNamespaces && curNamespaces[prefix] === uri) {
            output.$ = output.$ || {};
            output.$[`xmlns:${prefix}`] = curNamespaces[prefix];
          }
        }

        for (let name in input) {
          if (name === '$ns' || name === '$') {
            continue;
          }

          const ns = (Array.isArray(input[name])
            ? input[name][0].$ns
            : input[name].$ns) || { local: name, uri: 'DAV:' };

          let prefix = '';
          if (name.includes(':')) {
            prefix = name.split(':', 1)[0];
            if (!(prefix in prefixes)) {
              prefixes[prefix] = ns.uri;
            }
          }

          const el = ns.uri === 'DAV:' ? ns.local : `${ns.uri}%%${ns.local}`;
          output[el] = recursivelyRewrite(
            input[name],
            curLang,
            el,
            prefix,
            curNamespaces,
            element === 'prop'
          );
        }

        return output;
      } else {
        return input;
      }
    };

    const output = recursivelyRewrite(parsed);
    return { output, prefixes };
  }

  /**
   * Render XML that's in the form returned by `parseXml`.
   */
  async renderXml(xml: any, prefixes: { [k: string]: string } = {}) {
    let topLevelObject: { [k: string]: any } | undefined = undefined;
    const prefixEntries = Object.entries(prefixes);
    const davPrefix = (prefixEntries.find(
      ([_prefix, value]) => value === 'DAV:'
    ) || ['', 'DAV:'])[0];

    const recursivelyRewrite = (
      input: any,
      namespacePrefixes: { [k: string]: string } = {},
      element = '',
      currentUri = 'DAV:',
      addNamespace?: string
    ): any => {
      if (Array.isArray(input)) {
        return input.map((value) =>
          recursivelyRewrite(
            value,
            namespacePrefixes,
            element,
            currentUri,
            addNamespace
          )
        );
      } else if (typeof input === 'object') {
        const output: { [k: string]: any } =
          element === ''
            ? {}
            : {
                $: {
                  ...(addNamespace == null ? {} : { xmlns: addNamespace }),
                },
              };

        const curNamespacePrefixes = { ...namespacePrefixes };

        if ('$' in input) {
          for (let attr in input.$) {
            // Translate uri%%name attributes to prefix:name.
            if (
              attr.includes('%%') ||
              (currentUri !== 'DAV:' && !attr.includes(':') && attr !== 'xmlns')
            ) {
              const [uri, name] = attr.includes('%%')
                ? splitn(attr, '%%', 2)
                : ['DAV:', attr];

              if (currentUri === uri) {
                output.$[name] = input.$[attr];
              } else {
                const xmlns = Object.entries(input.$).find(
                  ([name, value]) => name.startsWith('xmlns:') && value === uri
                );
                if (xmlns) {
                  const [_dec, prefix] = splitn(xmlns[0], ':', 2);
                  output.$[`${prefix}:${name}`] = input.$[attr];
                } else {
                  const prefixEntry = Object.entries(curNamespacePrefixes).find(
                    ([_prefix, value]) => value === uri
                  );

                  output.$[
                    `${prefixEntry ? prefixEntry[0] + ':' : ''}${name}`
                  ] = input.$[attr];
                }
              }
            } else {
              if (attr.startsWith('xmlns:')) {
                // Remove excess namespace declarations.
                if (curNamespacePrefixes[attr.substring(6)] === input.$[attr]) {
                  continue;
                }

                curNamespacePrefixes[attr.substring(6)] = input.$[attr];
              }

              output.$[attr] = input.$[attr];
            }
          }
        }

        const curNamespacePrefixEntries = Object.entries(curNamespacePrefixes);
        for (let name in input) {
          if (name === '$') {
            continue;
          }

          let el = name;
          let prefix = davPrefix;
          let namespaceToAdd: string | undefined = undefined;
          let uri = 'DAV:';
          let local = el;
          if (name.includes('%%')) {
            [uri, local] = splitn(name, '%%', 2);
            // Reset prefix because we're not in the DAV: namespace.
            prefix = '';

            // Look for a prefix in the current prefixes.
            const curPrefixEntry = curNamespacePrefixEntries.find(
              ([_prefix, value]) => value === uri
            );
            if (curPrefixEntry) {
              prefix = curPrefixEntry[0];
            }

            // Look for a prefix in the children. It should override the current
            // prefix.
            const child = Array.isArray(input[name])
              ? input[name][0]
              : input[name];
            if (typeof child === 'object' && '$' in child) {
              let foundPrefix = '';
              for (let attr in child.$) {
                if (attr.startsWith('xmlns:') && child.$[attr] === uri) {
                  foundPrefix = attr.substring(6);
                  break;
                }
              }

              // Make sure every child has the same prefix.
              if (foundPrefix) {
                if (Array.isArray(input[name])) {
                  let prefixIsGood = true;
                  for (let child of input[name]) {
                    if (
                      typeof child !== 'object' ||
                      !('$' in child) ||
                      child.$[`xmlns:${foundPrefix}`] !== uri
                    ) {
                      prefixIsGood = false;
                      break;
                    }
                  }
                  if (prefixIsGood) {
                    prefix = foundPrefix;
                  }
                } else {
                  prefix = foundPrefix;
                }
              }
            }

            if (prefix) {
              el = `${prefix}:${local}`;
            } else {
              // If we haven't found a prefix at all, we need to attach the
              // namespace directly to the element.
              namespaceToAdd = uri;
              el = local;
            }
          }

          let setTopLevel = false;
          if (topLevelObject == null) {
            setTopLevel = true;
          }

          output[el] = recursivelyRewrite(
            input[name],
            curNamespacePrefixes,
            el,
            uri,
            namespaceToAdd
          );

          if (setTopLevel) {
            topLevelObject = output[el];
          }
        }

        return output;
      } else {
        if (addNamespace != null) {
          return {
            $: { xmlns: addNamespace },
            _: input,
          };
        }
        return input;
      }
    };

    const obj = recursivelyRewrite(xml, prefixes);
    if (topLevelObject != null) {
      const obj = topLevelObject as { [k: string]: any };

      // Explicitly set the top level namespace to 'DAV:'.
      obj.$.xmlns = 'DAV:';

      for (let prefix in prefixes) {
        obj.$[`xmlns:${prefix}`] = prefixes[prefix];
      }
    }
    return this.xmlBuilder.buildObject(obj);
  }

  /**
   * Format a list of locks into an object acceptable by xml2js.
   */
  async formatLocks(locks: Lock[], baseUrl: URL) {
    const xml = { activelock: [] as any[] };

    if (locks != null) {
      for (let lock of locks) {
        const secondsLeft =
          lock.timeout === Infinity
            ? Infinity
            : (lock.date.getTime() + lock.timeout - new Date().getTime()) /
              1000;

        if (secondsLeft <= 0) {
          continue;
        }

        xml.activelock.push({
          locktype: {
            write: {},
          },
          lockscope: {
            [lock.scope]: {},
          },
          depth: {
            _: `${lock.depth}`,
          },
          owner: lock.owner,
          timeout:
            secondsLeft === Infinity
              ? { _: 'Infinite' }
              : { _: `Second-${secondsLeft}` },
          locktoken: { href: { _: lock.token } },
          lockroot: {
            href: {
              _: (await lock.resource.getCanonicalUrl(baseUrl)).pathname,
            },
          },
        });
      }
    }

    if (!xml.activelock.length) {
      return {};
    }

    return xml;
  }
}
