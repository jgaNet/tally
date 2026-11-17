/** Length in characters (code points), so an emoji counts once. */
export function characters(text: string): number {
  return [...text].length;
}
