import { inspect } from 'node:util';
import xml2js from 'xml2js';

import { MultiStatus, PropStatStatus, Status } from './MultiStatus.js';

const multistatuspropstat = async () => {
  const multistatus = new MultiStatus();

  const container = new Status('http://www.example.com/container', 207);
  multistatus.addStatus(container);

  const containerProps = new PropStatStatus(200);
  containerProps.setProp({ test: ['value'] });
  container.addPropStatStatus(containerProps);

  const containerErrorProps = new PropStatStatus(403);
  containerErrorProps.description =
    'The user does not have access to the "restricted" property.';
  containerErrorProps.setProp({ restricted: {} });
  container.addPropStatStatus(containerErrorProps);

  const file = new Status('http://www.example.com/container/file', 207);
  multistatus.addStatus(file);

  const fileProps = new PropStatStatus(200);
  fileProps.setProp({ prop1: ['success'], prop2: ['more success'] });
  file.addPropStatStatus(fileProps);

  console.log(multistatus.render());
};
await multistatuspropstat();

const multistatuserror = async () => {
  const multistatus = new MultiStatus();

  const success = new Status('http://www.example.com/file', 200);
  multistatus.addStatus(success);
  const error = new Status('http://www.example.com/file2', 404);
  error.setBody({
    error: {
      something: {},
    },
  });
  multistatus.addStatus(error);

  console.log(multistatus.render());
};
// await multistatuserror();

const builder = async () => {
  let builder = new xml2js.Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
  });
  let parser = new xml2js.Parser();

  let obj = {
    multistatus: {
      $: {
        xmlns: 'DAV:',
      },
      subarrays: [[{ href: 'abc' }, { href: 'def' }]],
      toparrays: [{ href: 'abc' }, { href: 'def' }],
      response: [
        {
          href: { _: '/container/' },
          propstat: {
            prop: {
              $: {
                'xmlns:R': 'http://ns.example.com/boxschema/',
              },
              'R:bigbox': {
                'R:BoxType': { _: 'Box type A' },
              },
              'R:author': {
                'R:Name': { _: 'Hadrian' },
              },
              creationdate: { _: '1997-12-01T17:42:21-08:00' },
              displayname: { _: 'Example collection' },
              resourcetype: { collection: {} },
              supportedlock: {
                lockentry: [
                  {
                    lockscope: { exclusive: {} },
                    locktype: { write: {} },
                  },
                  {
                    lockscope: { shared: {} },
                    locktype: { write: {} },
                  },
                ],
              },
            },
            status: { _: 'HTTP/1.1 200 OK' },
          },
        },
        {
          href: { _: '/container/front.html' },
          propstat: {
            prop: {
              $: {
                'xmlns:R': 'http://ns.example.com/boxschema/',
              },
              'R:bigbox': {
                'R:BoxType': { _: 'Box type B' },
              },
              creationdate: { _: '1997-12-01T18:27:21-08:00' },
              displayname: { _: 'Example HTML resource' },
              getcontentlength: { _: '4525' },
              getcontenttype: { _: 'text/html' },
              getetag: { _: 'zzyzx' },
              getlastmodified: { _: 'Mon, 12 Jan 1998 09:25:56 GMT' },
              resourcetype: {},
              supportedlock: {
                lockentry: [
                  {
                    lockscope: { exclusive: {} },
                    locktype: { write: {} },
                  },
                  {
                    lockscope: { shared: {} },
                    locktype: { write: {} },
                  },
                ],
              },
            },
            status: { _: 'HTTP/1.1 200 OK' },
          },
        },
      ],
    },
  };

  let xml = builder.buildObject(obj);

  console.log(xml);
  console.log(inspect(await parser.parseStringPromise(xml), false, null));
};
// await builder();
