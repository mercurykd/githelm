import { PatchBuildError } from '../git/patch';
import { PatchApplyError } from '../git/stage';

/**
 * The sentence a failure shows the reader: a patch that did not apply says why in its own
 * words, and anything else says what it can.
 */
export function formatError(error: unknown): string {
  if (error instanceof PatchBuildError || error instanceof PatchApplyError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
