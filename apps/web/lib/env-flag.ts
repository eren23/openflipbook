// Boolean env-flag parse, shared by the API routes. The truthy set and
// default-false behaviour match the spelling that used to be inlined at each
// call site (`["1","true","yes"].includes((process.env.X ?? "").toLowerCase())`
// and its `flag === "1" || …` twin). Anything outside the set — empty,
// "0", "off", "no" — is false. `def` fills in when the var is UNSET only
// (mirror of the backend's env_flag(name, default)); pass "true" for a
// default-on flag whose =0 spelling is the kill switch.
export const envFlag = (name: string, def = "false"): boolean =>
  ["1", "true", "yes"].includes((process.env[name] ?? def).toLowerCase());
