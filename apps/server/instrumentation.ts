export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRetentionScheduler } = await import("./lib/retention");
    startRetentionScheduler();
  }
}
