// How old the last backup is, for the bulk import confirmation (brainstorm 5.16).
// Backups are not tracked until Phase 10, which replaces this with the real age.
// Resolves to { known: false } for now, or { known: true, days }.

export async function getBackupAge() {
  return { known: false };
}
