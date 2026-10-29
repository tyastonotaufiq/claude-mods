/**
 * One note, as kept in the Note Taker page's database: `text` (its first line
 * is the title), times in ms, and the document's `version`, which every write
 * to it must name.
 */
export type Note = { id: string; text: string; createdAt: number; updatedAt: number; version: number }

declare module 'claude-code' {
  interface PluginState {
    'note-taker': {
      notes: Note[]
      /** Whether the notes were read this session (the pane was opened) */
      loaded: boolean
      /** The open note's id; '' shows the list */
      openId: string
      confirmDelete: boolean
      busy: string
      message: string
      /** The person's Note Taker page, shown under the list; '' until it's known */
      notebookUrl: string
    }
  }
}
