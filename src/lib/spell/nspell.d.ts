// nspell (MIT) ne publie pas de types. Surface réellement utilisée par le correcteur.
declare module "nspell" {
  interface NSpellChecker {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string, model?: string): NSpellChecker;
    remove(word: string): NSpellChecker;
  }
  function NSpell(aff: string, dic: string): NSpellChecker;
  export default NSpell;
}
