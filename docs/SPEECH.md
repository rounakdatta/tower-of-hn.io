# How comments are said

A comment is said the way a person who knows the subject would read it aloud: "$1.2T" is "1.2 trillion dollars",
"e.g." is "for example", "LLMs" is "L L Ms", and a link is where it goes ("a GitHub link", "a link to N Y Post dot
com"), never its path. The words stay the commenter's; only their written forms change. Subtitles show what was written.

## Where it happens, and why there

towerd turns a comment's HTML into segments (`packages/core/src/speakable.ts`), and each sentence into its spoken form
(`spoken.ts`), before a runner voices it. The runners use Kokoro-82M v1.0 (fp16 ONNX) through kokoro-onnx 0.6.1, whose
reader is espeak-ng. What the engine allows, checked on 24 Nov 2026:

- **No SSML, no lexicon, no inline phonemes.** kokoro-onnx takes plain text, or a whole phoneme string instead of text.
- **espeak already handles a lot:** "3rd", "10,000", "9am", "v1.2.3", snake_case and camelCase identifiers, most
  acronyms ("GPU", "API" are spelled), and most brand names (Nvidia, Anthropic, Mistral).
- **It gets these wrong:** "$1.2T" is "dollar one point two T"; "nypost.com" is "nai-post com"; "LLMs" loses its s;
  ~200 frequent capitals are read as words ("OP" "op", "NYC" "nick", "ROI" "roy", "AGI" "ah-gi"); a lone capital A
  is the article "uh" ("A W S" is "uh W S"); "II" is "Roman two"; Qwen, Postgres, Clojure, Huawei come out wrong.

So the fix is text in, text out, before the engine: it works with any engine, costs ~0.3 ms per comment in towerd, and
changes nothing on the runners. Spelled names are one hyphenated word ("W-S-J", "F-Eh-Eh"): that is the form espeak
spells every letter of. Every table entry was read through espeak (`kokoro_onnx.tokenizer`), and the main cases were
synthesised with the real voice and transcribed with Parakeet TDT 0.6B v3:

| written | before | after |
|---|---|---|
| OpenAI is now valued at $1.2T | "valued at $1.2T" ("dollar one point two T") | "valued at $1.2 trillion" |
| (link) nypost.com | "Link Nightpostcom" | "A link to nypost.com" |
| (link) github.com | "Link Githubcom" | "A GitHub link." |
| the OP said, are NYC ROI | "the OP said are Nick Roy" | "the OP said, are NYCROI" |
| Nvidia, a $5T company, is 10x bigger | "a dollar five tea company" | "a $5 trillion company, is ten times bigger" |

(Parakeet writes numbers and names back in their written form, so "after" reads as what was heard, correctly.)

## What is said differently

Ranked by how often it occurs in 46,481 real comments (the 30 front-page threads plus 40,000 recent ones) times how
badly it was said:

- **Capitals:** plurals and possessives ("LLMs", "GPUs", "AMD's") are spelled with their s ("L-L-Ems"); capitals said
  as words keep their s in lower case ("ARM's" "arm's"); ~200 capitals espeak misreads are spelled; "MoE", "PoC",
  "DoJ" (capital, small, capital) are letters; "World War II" is "World War two".
- **Abbreviations:** e.g., i.e., etc., vs, w/, w/o, b/c, and/or, IMO, IIRC, AFAIK, FWIW, TL;DR, TIL, ELI5, YMMV, IME,
  TFA, OTOH and friends, in any case; Mr., Dr., St. before a name.
- **Money:** "$1.2T" "1.2 trillion dollars", "$300k", "$0.99" "99 cents", "$5/mo" "5 dollars a month", "$5-10" "5 to 10
  dollars", "~$5" "about 5 dollars"; €, £, ¥, ₹; before its noun the currency is singular ("a $5 coffee" "a 5 dollar
  coffee", "a $3T company").
- **Numbers:** "10M users" (K and B only before a count noun: "a 27B model" is said "27 B"), "10x" "10 times", ranges
  "2020-2024" "twenty twenty to twenty twenty-four", "5-10%", "~", "≈", "<", ">=", years, decades ("the 90s"), dates
  ("2026-11-24", "Nov 24"), times ("3:30pm"), units after a number ("16GB", "600W", "3.5GHz", "14nm", with plurals),
  fractions ("1/2", "24/7"), model numbers ("RTX 4090" "forty ninety", "1080p").
- **Links:** HN only links bare URLs, so a link is said where it stands, as what it is:
  - a platform by its brand: "a GitHub link", "a YouTube link", "a Wikipedia link", "an arXiv paper", "an archived
    copy", "another Hacker News thread";
  - any other site by its domain, said the way people say it: "N-Y Post dot com", "W-S-J dot com", "Ars Technica dot
    com", "BBC dot co dot U-K". A domain is the publication's name, and the placard shows it, so it is said, not
    rebranded. In a sentence it is just the name ("see N-Y Post dot com for details"); standing alone it needs a noun:
    "A link to N-Y Post dot com." "A link" was kept there: shorter forms ("N-Y Post dot com.") sound like a stray word.
  - several in a row are said once: "Three links: Wikipedia, YouTube and N-Y Post dot com."; a repeat is "another
    GitHub link"; an IP address or a very long host is "a link"; a subdomain is dropped ("static-assets-1.truthsocial.com"
    is "truth social dot com").
- **Code and marks:** fenced code is "Here's 5 lines of code."; inline code is read (espeak splits identifiers);
  footnote marks [1], bullets, ** and * are dropped; arrows are "to"; "#1" is "number 1"; a quote of the parent is
  replayed in the parent's voice, any other quote is "Quote: … End quote."

Anything it isn't sure of is left as written for the engine. Other scripts are untouched.

## How far it gets

- **Links (4,647 in the sample):** 66% are said from the tables (sites 42%, domain names 15%, HN threads 9%). The other
  34% go through the fallback, which splits a domain into words with a frequency list of 30,000 words from HN comments
  ("truthsocial" "truth social", "opencollective" "open collective") and spells short or vowel-less names ("crfb"
  "C-R-F-B"); in a random sample of 80 of those, 72 sounded right. About 97% of links overall.
- **Names (38,412 capitalised names and acronyms):** 17.5% were said wrong and are now said right. The rest espeak
  already says right, except a long tail: 1.8% are capitals it reads as a word, about half of them correctly (JIT,
  POTUS, FAQ). A universal fix is not possible; the tables grow from real traffic:

```
node packages/core/tools/speech-report.ts            # live: the 30 front-page threads
node packages/core/tools/speech-report.ts file.json  # or a saved sample
```

It lists the hosts said by the fallback and the names read as written, most frequent first. Check a new form through
espeak before adding it to `spoken-data.ts`.

## The contract with the runners

A say or quote segment's `text` has one spoken line per sentence of its `display`, split by `sentences` (speakable.ts),
which `sentences` in worker.py must match exactly; the runner packs clips by what is said and subtitles each with the
same sentences as written. A link segment's `say` is what is said for it where it stands alone ('' when it was said in
its sentence). Audio already voiced keeps its old reading until it is voiced again (a `VOICE_VERSION` bump re-voices
everything in the background).
