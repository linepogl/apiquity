# Apiquity

A web component that displays an **OpenAPI** and/or an **AsyncAPI** document as one browsable API: endpoints and
operations side by side, grouped by tag, with their parameters, bodies and messages.

It is a single ES module (about 33 kB gzipped) that defines the `<apiquity-ui>` element. Its styles live in a shadow
root, so it doesn't affect the page it is embedded in.

## Usage

```html
<script type="module" src="https://unpkg.com/@linepogl/apiquity/dist/apiquity.js"></script>

<apiquity-ui openapi="openapi.json" asyncapi="asyncapi.yaml" routing="hash"></apiquity-ui>
```

Pin a version in production, e.g. `https://unpkg.com/@linepogl/apiquity@0.2.0/dist/apiquity.js`.

### Attributes

| Attribute  | Description                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openapi`  | URL of an OpenAPI 3.x document, JSON or YAML.                                                                                                     |
| `asyncapi` | URL of an AsyncAPI document (3.x, or 2.x), JSON or YAML.                                                                                          |
| `routing`  | `hash`: what is shown is kept in the page's URL hash, for deep links and back/forward. Otherwise (the default) it stays inside the component. |

At least one of `openapi` and `asyncapi` is required.

### Styling

| Custom property         | Description                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `--apiquity-ui-height`  | Height of the component when an endpoint is open (list + details). Default: `100vh`.          |

Light and dark themes follow the user's `prefers-color-scheme`.

### Events

| Event  | Description                                                                            |
| ------ | -------------------------------------------------------------------------------------- |
| `load` | Once the documents are loaded. `event.detail.title` is the API's title.                |

```js
document.querySelector("apiquity-ui").addEventListener("load", (e) => (document.title = e.detail.title));
```

## Features

- **One list for both specs.** OpenAPI endpoints (`GET`, `POST`…) and AsyncAPI operations (`SEND`, `RECEIVE`, marked
  with an envelope) are grouped by tag, in alphabetically sorted sections; a tag found in both specs is one section.
  AsyncAPI operations are grouped by their tags joined together, ignoring the tags that every operation has.
- **Search.** Start typing anywhere on the page: the endpoints and operations whose path, address, method, summary,
  tag… contain every word are listed. Escape returns to the page the search started from.
- **Schemas** as expandable trees: types, constraints, defaults, examples, enums and constants; `oneOf`/`anyOf` as
  tabs, named after the discriminator's values when there is one; `readOnly` properties hidden in requests and
  `writeOnly` ones in responses.
- **Message envelopes.** In an AsyncAPI payload with a `payload` or `body` property, that property starts expanded and
  the properties around it (the envelope) are dimmed.
- **Examples** generated from the schemas when the spec gives none, and the **JSON Schema** of every body, with
  `$ref`s inlined.
- **Sources.** The `OpenAPI 3.1.0` / `AsyncAPI 3.0.0` tags in the title bar show each file as written, with a button
  to download it.

### Addresses (with `routing="hash"`)

| Hash                                   | Page                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| `#`                                    | Home: the list of endpoints and operations.           |
| `#get/api/orders/{id}`                 | An endpoint, by method and path.                      |
| `#get/api/orders/{id}@response-200`    | …with a tab selected (`@request`, `@response-<code>`).|
| `#asyncapi/<operation id>`             | An AsyncAPI operation.                                |
| `#asyncapi/<operation id>@message-<key>` | …with one of its messages selected.                 |
| `#?<query>`                            | Search results.                                       |
| `#source/openapi`, `#source/asyncapi`  | A spec's file, as written.                            |

## Development

Requires Node.js 23.6 or later (the dev server is TypeScript run directly by Node).

```sh
npm install
npm run build        # dist/apiquity.js (npm run dev: rebuild on change)
npm run typecheck
```

To try it on your own documents, run the dev server with one or two files (at most one OpenAPI and one AsyncAPI,
JSON or YAML; each file's kind is read from its content):

```sh
node server/server.ts path/to/openapi.json path/to/asyncapi.yaml [--port 8080]
```

and open <http://localhost:8080>. The files are read again on each request, so edits show up on reload. `npm start`
does the same with `spec/openapi.json` and `spec/asyncapi.yaml` (the `spec/` folder is not versioned).

## Releasing

Releases are published to npm (and so to unpkg) by hand:

```sh
npm version patch    # or minor / major: updates package.json and creates the git tag
npm run release      # type-checks, builds, publishes to npm, then pushes the commit and the tag
```

`npm publish` asks for a one-time password when two-factor authentication is on.

## License

[MIT](LICENSE)
