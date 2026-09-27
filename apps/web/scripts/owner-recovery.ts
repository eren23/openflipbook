import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CreatorError } from "../lib/creator-error";
import { inspectOwnerRecovery, issueOwnerRecovery, revokeOwnerRecovery } from "../lib/owner-recovery";

const help = `Operator-only world ownership recovery. Uses configured MongoDB.
  inspect --world WORLD_ID
  issue --world WORLD_ID --reason "Verified creator identity" [--minutes 15]
  revoke --grant GRANT_ID --reason "Code withdrawn"

Issue prints a secret, single-world recovery code. Deliver it privately.
Verify the intended creator before issuing. Never publish the code in a URL.
Issuing a new code revokes the previous pending code, not current access.
Redemption transfers that world only; accepted requests/jobs may still finish.`;

export function parseRecoveryCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    world: { type: "string" }, grant: { type: "string" }, reason: { type: "string" }, minutes: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help && !positionals.length) return { action: "help" as const };
  const action = positionals[0];
  if (positionals.length !== 1 || values.help || !["inspect", "issue", "revoke"].includes(action ?? "")) throw new CreatorError(help, 400);
  if (action === "inspect" && values.world && !values.grant && !values.reason && !values.minutes) return { action, world: values.world } as const;
  if (action === "issue" && values.world && values.reason && !values.grant) return { action, world: values.world, reason: values.reason, minutes: values.minutes === undefined ? 15 : Number(values.minutes) } as const;
  if (action === "revoke" && values.grant && values.reason && !values.world && !values.minutes) return { action, grant: values.grant, reason: values.reason } as const;
  throw new CreatorError(help, 400);
}
async function main() {
  const command = parseRecoveryCommand(process.argv.slice(2));
  if (command.action === "help") { process.stdout.write(help + "\n"); return; }
  try {
    const result = command.action === "inspect" ? await inspectOwnerRecovery(command.world)
      : command.action === "issue" ? await issueOwnerRecovery(command.world, command.reason, command.minutes)
      : await revokeOwnerRecovery(command.grant, command.reason);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally { await globalThis.__endlessCanvasMongo?.client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => {
  process.stderr.write((error instanceof CreatorError ? error.message : "Recovery command failed. Check arguments, MongoDB connectivity and replica-set health.") + "\n"); process.exitCode = 1;
});
