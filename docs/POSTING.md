# Replying by voice, and posting to Hacker News

The goal, in Rounak's words: walk up to the person you want to answer, speak, confirm, and it's posted, and when
anyone answers you, you hear it. This note is what exists (0.4.1), what we can't do and why, and the plan.

## What exists now

- **The reply sheet** (`apps/client/src/reply.ts`). It opens from someone's card, from their name in the
  subtitles (answering exactly that line), from Reply while seated (whoever is speaking), or with R on desktop.
  - The person you're answering turns to you.
  - The room goes nearly silent while the microphone is open, so it hears you, not the toys. A seated table pauses.
  - Their comment is quoted, and the mic fills an editable box live.
  - **Your words, exactly:** the browser turns speech into text, and the only change we make is a capital letter
    to start. No model touches the text, because HN asks for human comments (see the guidelines below).
- **Posting is a hand-off**, today, on every device. "Continue on Hacker News ↗":
  1. Your words are copied, and HN's own reply page opens for that comment (`/reply?id=<comment>&goto=...`).
  2. You paste and press **reply** there. HN's button is the confirmation.
  3. Back in the room, "Done, I posted it" closes the sheet and says the app is watching.
  - The words stay visible in the sheet, in case the copy fails or logging in to HN overwrites the clipboard.
- **Your HN username** is kept in your browser only. It is optional, and is asked for after the button.
  - With it, your reply *walks in*: when HN shows your comment, your character comes out of the lift and says it.
    The lamp flares orange, the line is spotlit (you hear yourself from anywhere on the floor), and the subtitle
    says YOU.
  - **Replies to you** are played. One on the floor you're on is said next at its table and spotlit, so that
    table becomes the one you hear, wherever you are, once its voice is ready. One anywhere else on HN gets a note.
  - Your recent comments are checked every two minutes, straight from your browser to HN's public API
    (`hacker-news.firebaseio.com`, now allowed by the page's CSP). Nothing of yours passes through our server.
- **The companion extension** (`apps/extension`, a sketch: not published, not installed, never run against HN).
  - It is MV3. Its content script runs only on TowerOfHan's own pages.
  - It posts with the browser's existing HN session: it fetches the reply page for the form's one-time token, then
    POSTs the form, exactly as HN's own page would.
  - **Every post needs a click in the extension's own confirmation window**, so a page, even a compromised one,
    can only *ask*.

## Why we can't just "use the login cookies"

A page on our domain can never read or send another site's cookies; that's the browser's same-origin policy, and it
is the reason the web is safe at all. HN's cookie belongs to news.ycombinator.com; our page can open HN, but it can't
act as you on it. Only three things can:

| | how | seamless | security | verdict |
|---|---|---|---|---|
| **Hand-off** (shipped) | copy + HN's reply page; you press reply | two taps more | nothing of yours touches us | **now, everywhere** |
| **Companion extension** | your browser posts with your own session, after its own confirm window | one tap (and a confirm) | no password, no cookie leaves your browser | **desktop next** |
| **Server-side login** | you give us your HN password; we keep your cookie | most seamless, every device | we'd hold every user's HN account; HN's login CAPTCHA and limits from one datacenter IP | **no** |

**Why not the server-side login:**
- A breach would hand out every user's HN identity.
- HN users would rightly refuse to give a password to a third party.
- Logins from one server IP would run into HN's CAPTCHA and rate limits, and look like a bot farm.
- Pasting your cookie instead is the same custody problem.

**On phones**, the most seamless honest version is a native wrapper (iOS/Android), like the existing HN apps.
You'd log in to HN once inside an in-app browser page served by HN itself, the cookie would stay on the device, and
replies would post in one tap after the same confirm. That's a later project. Until then, the hand-off is what works
on a phone.

## Speech to text

- **Now:** the browser's own recognition (Web Speech API).
  - Chrome on desktop and Android: Google's service.
  - Safari on macOS and iOS: Apple's, on-device for many languages.
  - It's free and fast, and it uses your browser's language.
  - Firefox has none, so the sheet says so and you type.
- **Later, for privacy or offline use:** an on-device model in the browser (a small Whisper through WebGPU, roughly
  40–150 MB, downloaded once). Opt-in, because of the download.
- **Punctuation:** Chrome returns little. A punctuation-only pass would be allowed only if it can't change a single
  word (checked by comparing the word sequence), and only if HN's rules allow even that. Until then, you edit.

## Safety and privacy checklist

- [x] Nothing posts without the user's own click: on HN's page (hand-off) or in the extension's own window.
- [x] No passwords or cookies ever reach our server.
- [x] Speech recognition runs in the browser; we never receive audio.
- [x] HN text is parsed in an inert document (`DOMParser`); every name and line is escaped.
- [x] The extension talks only to TowerOfHan's own origins, matches each answer to its request, and is limited to
      news.ycombinator.com.
- [x] Your HN name lives in localStorage only; clearing it stops the watch.
- [ ] Before publishing the extension: a review of HN's current reply-form HTML (field names change rarely, but they
      can), a per-minute post limit inside the extension, and Chrome Web Store, Firefox and Safari packaging.
- [ ] Never test posting against HN from Rounak's account without asking first.

## Open questions for Rounak

1. Publish the companion extension (Chrome and Firefox first)? It's the one-tap path on desktop.
2. A native wrapper for phones, later?
3. Should replies to you also reach you while the page is closed (web push)? That needs a server-side watch keyed
   by HN username, which is still public data, but it would be the first per-user state we keep.
