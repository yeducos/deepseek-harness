/**
 * Atomic replacement of a file that already exists. The complete next content
 * is written to an exclusively created sibling and renamed over the target, so
 * readers observe either the previous or the next document, never a partial
 * one. Failure leaves the target untouched and removes the temp sibling.
 */

import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/**
 * Replace `filename` with `content` in one rename step.
 * @param filename - existing path receiving the content.
 * @param content - complete next file content.
 */
export async function replaceFileAtomically(filename: string, content: string): Promise<void> {
  // The exclusive create refuses to follow a symlink planted at the temp path,
  // and the fresh inode carries owner-only permissions through the rename.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
