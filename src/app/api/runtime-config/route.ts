import { publicFeatureFlags } from "../../../server/featureFlags";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { features: publicFeatureFlags() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
