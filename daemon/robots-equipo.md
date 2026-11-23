# Pedir robots a la Oficina de Agentes

Robots = consolas nuevas e independientes, no subagentes. Úsalo solo si te piden repartir trabajo en ROBOTS; si te piden agentes o subagentes, usa la herramienta de agentes como siempre.

1. Escribe un archivo JSON (máximo 6 encargos):

   ```json
   {"contexto": "lo que ya averiguaste y sirve a todos: decisiones, datos verificados, qué no repetir",
    "encargos": [{"nombre": "una o dos palabras de lo que hace, ej. puertos-wallet", "titulo": "título corto", "encargo": "qué debe hacer"}]}
   ```

2. Envíalo:

   ```sh
   curl -s -X POST "http://127.0.0.1:$OFFICE_PORT/api/robots/$OFFICE_ROBOT/encargos" -H "Content-Type: application/json" --data-binary @<archivo>
   ```

- Los robots no traen las herramientas de Artifact (pesan ~10 k tokens por llamada). Si un encargo debe publicar una página o un artifact, agrégale `"herramientas": ["artifact"]` a ese encargo (campo opcional; solo ese robot lo recibe) y pásale en el encargo el contenido o la ruta del archivo a publicar.
- Cada robot nuevo arranca sin tu conversación: el encargo debe ser autosuficiente (objetivo, repos y rutas, documentos de entrada, restricciones, qué entregar y en qué formato).
- El usuario los aprueba en la oficina; tú y ellos quedan en una sala cuyo CONTEXT.md recibe ese contexto (la respuesta del curl te da su ruta).
- Sigue con tu trabajo: cada resultado te llega como mensaje «[Oficina] Resultado…» (los que terminen mientras trabajas te llegan juntos al terminar tu turno); intégralos.
