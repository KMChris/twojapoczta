// Wybór widocznych spinaczy dla otwartego listu (opcja B). Czysta polityka bez DOM,
// żeby dała się przetestować w `node --test` — pad rodziny „załącznik znika" siedział
// właśnie tutaj, w kliencie, a testu nie miał.
//
// Serwer oddaje WSZYSTKIE załączniki (opcja B) i mapuje każdy Content-ID; klient chowa
// spinacz tylko dla tego, którego obrazek renderer NAPRAWDĘ wstawił w treść (`uzyteCid`).
// Gdy kilka załączników dzieli TEN SAM Content-ID, trasa `cid:` serwuje w treść tylko
// PIERWSZY wiersz (`getAttachmentByCid`, `ORDER BY a.id` + `.get()`), więc chowamy dokładnie
// jego jeden spinacz — po jednym na skonsumowany Content-ID. Duplikaty ZOSTAJĄ pod listem;
// inaczej druga kopia znikłaby z aplikacji (nie ma jej w treści ani pod listem) — to była
// regresja, którą ta funkcja domyka.
//
// Kontrakt kolejności: `zalaczniki` przychodzą w tej samej kolejności, w której trasa `cid:`
// wybiera pierwszy wiersz — `listAttachments` (lista) i `getAttachmentByCid` (treść) sortują
// tak samo (`ORDER BY a.id`). Gdyby któraś strona sortowała inaczej, „pierwszy" tutaj nie byłby
// tym, który trasa serwuje, i chowalibyśmy nie ten spinacz.
export function widoczneSpinacze(zalaczniki, uzyteCid) {
  const schowane = new Set(); // Content-ID już schowane · jeden spinacz na wartość
  return zalaczniki.filter((z) => {
    if (z.content_id && uzyteCid.has(z.content_id) && !schowane.has(z.content_id)) {
      schowane.add(z.content_id);
      return false; // chowamy TEN pierwszy — to jego serwuje trasa cid:
    }
    return true; // reszta zostaje: bez content_id, nieskonsumowany, ALBO duplikat
  });
}
