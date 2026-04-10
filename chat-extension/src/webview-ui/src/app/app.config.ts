import { type ApplicationConfig, importProvidersFrom, provideExperimentalZonelessChangeDetection } from "@angular/core";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { TranslateLoader, TranslateModule } from "@ngx-translate/core";
import { Observable, of } from "rxjs";

import en from "../assets/i18n/en.json";
import it from "../assets/i18n/it.json";

const TRANSLATIONS: Record<string, Record<string, string>> = { en, it };

class StaticTranslateLoader implements TranslateLoader {
  getTranslation(lang: string): Observable<Record<string, string>> {
    return of(TRANSLATIONS[lang] ?? TRANSLATIONS["en"]);
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideExperimentalZonelessChangeDetection(),
    provideAnimationsAsync(),
    importProvidersFrom(
      TranslateModule.forRoot({
        defaultLanguage: "en",
        loader: { provide: TranslateLoader, useClass: StaticTranslateLoader },
      }),
    ),
  ],
};
