import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, getPlatformProxy } from "wrangler";

async function request() {
  const [method = "GET", path = "/_ordo/goals", body] = process.argv.slice(2);
  const { rawConfig } = experimental_readRawConfig({
    config: fileURLToPath(new URL("wrangler.jsonc", import.meta.url)),
  });
  if (!rawConfig.account_id)
    throw new Error("Set account_id in example/wrangler.jsonc");
  process.env.CLOUDFLARE_ACCOUNT_ID = rawConfig.account_id;

  const proxy = await getPlatformProxy({
    configPath: fileURLToPath(
      new URL("wrangler.caller.jsonc", import.meta.url),
    ),
    persist: false,
    remoteBindings: true,
  });
  try {
    const response = await proxy.env.ORDO.fetch("https://ordo" + path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body }),
    });
    console.log("HTTP " + response.status);
    console.log(await response.text());
    if (!response.ok) process.exitCode = 1;
  } finally {
    await proxy.dispose();
  }
}

request().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
