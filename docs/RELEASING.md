# Publicar Wacon en npm

El paquete es **`@josetra/wacon`** y el ejecutable es **`wacon`**. Requiere Node.js 22.18.0 o superior. La publicación es pública y usa el registro oficial de npm.

## Validación local

```bash
npm ci
npm run check
npm pack --dry-run --ignore-scripts
npm pack
```

Revisa que el paquete incluya `dist/index.js`, `dist/daemon.js`, los stickers, las dos skills, el script de instalación, README y licencia. La lista `files` limita el contenido publicado; no añadas sesiones, bases de datos ni credenciales.

Prueba el archivo generado en una carpeta temporal fuera del repositorio:

```bash
npm install --prefix ./smoke /ruta/absoluta/josetra-wacon-0.4.0.tgz
node ./smoke/node_modules/@josetra/wacon/dist/index.js --version
node ./smoke/node_modules/@josetra/wacon/dist/index.js --help
node scripts/smoke-package.mjs ./smoke/node_modules/@josetra/wacon
```

Sustituye la versión y la ruta por las del archivo generado. Ejecuta el script `smoke-package.mjs` desde el repositorio, pasando la ruta absoluta al paquete instalado si la carpeta temporal está fuera. Verifica versión del CLI/MCP, herramientas MCP, archivos incluidos y SQLite nativo sin iniciar sesión en WhatsApp. Para evitar instalar las skills durante esta comprobación, define `WACON_SKIP_POSTINSTALL=1` en el entorno.

## Primera publicación

Necesitas una cuenta npm con permisos para el scope `@josetra` y autenticación de dos factores. Comprueba que la versión aún no exista:

```bash
npm login
npm whoami
npm view @josetra/wacon versions --json
```

Un 404 puede indicar que el paquete todavía no existe; no demuestra que tengas permisos sobre el scope. Una versión publicada no se puede reutilizar.

Si el paquete aún no existe, realiza la primera publicación manual desde una copia validada:

```bash
npm publish --access public
```

Este comando publica de verdad. Ejecuta antes `prepublishOnly` (TypeScript y tests) y `prepare` (compilación).

## Publicaciones posteriores desde GitHub

En npmjs.com, abre la configuración del paquete y añade un **Trusted Publisher** con estos valores:

| Campo | Valor |
| --- | --- |
| Proveedor | GitHub Actions |
| Organization or user | `JOSETRA44` |
| Repository | `wacon-mcp` |
| Workflow filename | `publish.yml` |
| Environment | Dejar vacío |
| Allowed actions | Permitir `npm publish` |

El workflow usa OIDC con `id-token: write`; no necesita `NPM_TOKEN`. Esta vinculación requiere acceso a la cuenta npm y no se crea al editar el repositorio. Consulta la [documentación oficial de Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

Para cada nueva versión:

1. Actualiza `package.json` y `package-lock.json` juntos con `npm version patch --no-git-tag-version` (o `minor` / `major`).
2. Ejecuta las validaciones y sube los cambios revisados al repositorio.
3. Espera a que CI pase en Windows y Linux con Node 22 y 24.
4. Crea una GitHub Release con tag `v<version>`, por ejemplo `v0.4.1`, apuntando al commit validado.
5. El workflow verifica el tag, instala dependencias, ejecuta tipos/tests, recompila y publica con provenance.

Las releases marcadas como prerelease no se publican con este workflow. No crees una release de una versión ya publicada manualmente esperando volver a publicarla: npm la rechazará.

## Qué queda fuera del repositorio

Los permisos del scope, el inicio de sesión, la configuración del Trusted Publisher y la publicación efectiva se gestionan en npm/GitHub. El código y el workflow pueden estar preparados sin que esas acciones se hayan realizado.
