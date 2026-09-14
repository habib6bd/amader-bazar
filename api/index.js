/* Vercel serverless entry point.

   Vercel looks for handlers under api/, so this re-exports the Express app as
   the function that answers every request. server.js skips app.listen() when
   the VERCEL environment variable is present, so the same file still runs as an
   ordinary server on the shop's PC. */
export { default } from '../server.js';
