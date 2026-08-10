export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  return res.status(200).json({
    ok: true,
    service: "BestSeller AI",
    status: "healthy",
    timestamp: new Date().toISOString(),
    checks: {
      api: true,
      composer_env_present: Boolean(process.env.GEMINI_API_KEY),
      composer_secret_configured: Boolean(process.env.COMPOSER_SHARED_SECRET),
    },
  });
}
