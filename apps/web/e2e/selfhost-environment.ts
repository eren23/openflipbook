/** Only the runner's isolated loopback stores may be read or changed. */
export interface SelfhostReceipt {
  project: string; compose_file: string; origin: string; mongo: string;
  database: string; fixture_providers: boolean;
}
export function assertSelfhostReceipt(receipt: SelfhostReceipt, baseURL: string | undefined) {
  if (!/^ofb-check-[a-f0-9]{12}$/.test(receipt.project) || receipt.origin !== baseURL || !receipt.fixture_providers
    || receipt.database !== "selfhost_check" || new URL(receipt.mongo).hostname !== "127.0.0.1"
    || new URL(receipt.origin).hostname !== "127.0.0.1") throw new Error("Expected an isolated self-host receipt");
}
