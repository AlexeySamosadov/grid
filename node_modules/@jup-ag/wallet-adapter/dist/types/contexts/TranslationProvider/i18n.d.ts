export declare const DEFAULT_LANGUAGE: "en";
export declare const OTHER_LANGUAGES: readonly ["zh", "vi", "fr", "ja", "id", "ru"];
export type AllLanguage = typeof DEFAULT_LANGUAGE | (typeof OTHER_LANGUAGES)[number];
export declare const LANGUAGE_LABELS: Record<AllLanguage, string>;
export declare const i18n: Record<string, {
    [key in (typeof OTHER_LANGUAGES)[number]]?: string;
}>;
