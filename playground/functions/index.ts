import { handleTravel } from "./handler.mjs";

Deno.serve((request: Request) => handleTravel({ request, supabase: null, env: (n: string) => Deno.env.get(n) }));