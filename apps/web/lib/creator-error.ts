// Shared by request handlers and the standalone generation worker.
export class CreatorError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
