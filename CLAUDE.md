# agent-office

Oficina de Agentes: daemon en Node (`daemon/`), interfaz de la oficina (`web/`) y del edificio (`edificio/`), CLI (`bin/office`). Qué hace cada carpeta y cómo se prueba: `README.md`.

## Editar
- Edita con la herramienta Edit (o Write para archivos nuevos). No escribas scripts de buscar y reemplazar (`python3 - <<EOF def rep(...)`): cuestan tokens de salida cada vez y fallan en silencio.

## Verificar la interfaz sin capturas
Las capturas de pantalla se quedan en el contexto y se releen en cada turno siguiente. Para revisar `web/` o `edificio/`:
- Primero, con texto: las pruebas (`node --test --test-force-exit test/unit.test.mjs` y la de integración del README) y el DOM ya renderizado, por ejemplo
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --virtual-time-budget=3000 --dump-dom http://127.0.0.1:<puerto>/ | grep -c 'clase-o-texto-esperado'`.
- Si de verdad hace falta mirar cómo se ve, que lo haga un subagente: toma la captura, la reduce (`sips -Z 800 captura.png`), la mira y devuelve en texto lo que encontró. El hilo principal no lee imágenes.
- Una sola captura por cambio, no una por intento.
