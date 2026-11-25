# Replying by voice, and posting to Hacker News

The goal, in Rounak's words: walk up to the person you want to answer, speak, confirm, and it's posted, and when
anyone answers you, you hear it. This note is what exists (0.5.x, after the 25 Nov QA pass), what we can't do and
why, and the plan. The QA report (flows, results, numbers, risks) is in Nextcloud `current/hobby/towerofhn/`.

## What exists now

- **The reply sheet** (`apps/client/src/reply.ts`, with `reply.css`; loaded the first time you reply, or when you sit
  down, so it isn't part of the first load). It opens from someone's card, from their name in the subtitles
  (answering exactly that line), from Reply while seated (whoever is speaking), or with R on desktop.
  - The person you're answering turns to you.
  - The room goes nearly silent while the microphone is open, so it hears you, not the toys. A seated table pauses.
  - Their comment is quoted, and the mic fills an editable box live. Typing takes over from the mic at once.
  - **Your words, exactly:** the browser turns speech into text (Google's service in Chrome, Apple's in Safari; the
    sheet says which), and the only changes we make are spacing and a capital where a sentence starts
    (`dictation.ts`). No model touches the text, because HN asks for human comments (see the guidelines below).
  - **Nothing is lost:** a draft per comment is kept in this browser (a week, the latest 20) through closing the
    sheet, Esc, answering someone else, a reload, or a phone dropping the tab while you're on HN.
  - **A preview** shows what HN will make of it (italics, code, links, paragraphs: `hnformat.ts`, from formatdoc),
    offered only when the text has any of those.
  - It says before you write when HN won't take a reply: a deleted comment, or a thread closed after two weeks.
  - Microphone problems are said plainly and stay on screen (blocked, Siri off, no mic, offline, no speech).
  - On a phone it sits above the keyboard (the visual viewport) and gives the box and the button the room.
  - Keyboard: Enter on the mic talks, ⌘/Ctrl+Enter sends, Esc stops listening and then closes; focus goes back to
    where it was. Screen readers get a labelled dialog, a live status line and a pressed state on the mic.
- **Posting is a hand-off**, today, on every device. "Continue on Hacker News ↗":
  1. Your words are copied, and HN's own reply page opens for that comment (`/reply?id=<comment>&goto=...`).
  2. You paste and press **reply** there (signing in first, on HN's own page, if it asks). HN's button is the
     confirmation; we never see a password.
  3. Meanwhile the sheet watches HN's public API for your reply under that comment (new answers only, matched by
     your name or your words), and says **Posted**, with a link to it and HN's two-hour edit and delete window.
     It keeps watching through a reload (ten minutes in all), and a note says so if you've closed the sheet.
  - The words stay in the sheet, with Copy again, Open it again and Edit, in case the copy fails, signing in
    overwrites the clipboard, or HN refuses it ("posting too fast", an expired form).
- **Your HN username** is kept in your browser only. Nobody types it: it's learned when your reply lands (from your
  own words, five or more of them), and the sheet shows it ("as alice": change it, or forget it).
  - With it, your reply *walks in*: when HN shows your comment, your character comes out of the lift and says it.
    The lamp flares orange, the line is spotlit (you hear yourself from anywhere on the floor), and the subtitle
    says YOU.
  - **Replies to you** are played. One on the floor you're on is said next at its table and spotlit, so that
    table becomes the one you hear, wherever you are, once its voice is ready. One anywhere else on HN gets a note.
  - Your recent comments are checked every two minutes, straight from your browser to HN's public API
    (`hacker-news.firebaseio.com`, allowed by the page's CSP). Nothing of yours passes through our server.
- **The companion extension** (`apps/extension`: not published, not installed, never run against HN; tested against
  the HN mock, `background.test.ts`).
  - It is MV3. Its content script runs only on Tower of HN's own pages.
  - It posts with the browser's existing HN session: it fetches the reply page for the form's one-time token, then
    POSTs the form, exactly as HN's own page would.
  - **Every post needs a click in the extension's own confirmation window**, so a page, even a compromised one,
    can only *ask*. Closing that window is a no.
- **Tests**: `apps/client/e2e` is a local mock of HN (its login and reply pages and its API: `hn-mock.ts`, with where
  each string comes from) and Playwright tests of every reply flow, in Chromium, Firefox and WebKit, on desktops, an
  iPhone and a Pixel (`npm run e2e` in `apps/client`; CI runs them). Nothing in them reaches the real HN.

## What we checked (22 Nov 2026)

Each fact below has a source in the research notes (`docs/posting-research-2026-11-22.md`). V means read from a
primary source; I means inferred.

- **HN's rule [V].** "Don't post generated text or AI-edited text. HN is for conversation between humans."
  ([guidelines](https://news.ycombinator.com/newsguidelines.html)). dang, March 2026: the AI-edited clause targets
  people who "run this through ChatGPT to fix my grammar and spelling"; "we'd rather hear you in your own voice"
  ([item 47346253](https://news.ycombinator.com/item?id=47346253)). For submissions the rule adds: "please don't
  automate posting".
  - [I] Speech-to-text of your own words is your text; an LLM rewrite is "AI-edited text". So nothing rewrites.
- **The reply form [V].**
  - The reply link is `reply?id=<comment>&goto=item%3Fid%3D<story>%23<comment>`.
  - The form is `<form action="comment" method="post">`, with hidden `parent`, `goto` and `hmac` (a one-time
    token) and a `text` textarea.
  - The login form posts `acct` and `pw`; the session cookie is `user`.
  - HN may answer with a resubmission confirm (`/x?fnop=commconfirm`) or "You're posting too fast". It never
    returns the new comment's id, so re-read the thread before any retry, or you can double-post.
  - Sources: the live pages, and maintained clients (weiran/Hackers, Hacki, Harmonic).
- **Another site can't use your HN session [V].** HN sends no CORS headers, refuses framing (`X-Frame-Options: DENY`),
  and a Lax cookie isn't sent on a cross-site fetch or POST.
- **An extension can [V].** Chromium: "Requests from an extension to a third-party are treated as same-site if the
  extension has host permissions for the third-party." This doesn't hold when third-party cookies are blocked
  (Incognito). Fetch from the service worker with `credentials: 'include'`. A content script that bridges
  `window.postMessage` is the portable channel; Firefox has no `externally_connectable`.
- **Logins can hit a CAPTCHA [V].** dang: "we do sometimes turn captchas on for logins when HN is under some kind of
  (possible) attack". A third-party server can't present it, which rules out a server-side login.
- **Speech [V].**
  - iOS Safari: `webkitSpeechRecognition` since 14.5. It needs Siri enabled, and isn't available in a home-screen
    web app; there the sheet offers typing instead. Chrome 139+: unprefixed `SpeechRecognition`, plus
    `processLocally` for on-device recognition once installed. Firefox 160: on-device, desktop only.
  - In-browser fallbacks: whisper-tiny.en ≈ 38 MB; moonshine-tiny ≈ 26 MB, about 5× less compute than Whisper
    tiny.

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
- [x] The extension talks only to Tower of HN's own origins, matches each answer to its request, and is limited to
      news.ycombinator.com.
- [x] Your HN name lives in localStorage only; clearing it stops the watch.
- [x] The extension never double-posts. It looks for your reply under that comment before posting (HN returns no
      id; it compares the words alone, so HN's formatting doesn't hide it), never retries blind, and answers HN's
      resubmission confirm once.
- [ ] Before publishing the extension: a review of HN's current reply-form HTML (field names change rarely, but they
      can), a per-minute post limit inside the extension, and Chrome Web Store, Firefox and Safari packaging.
- [ ] Consider Chrome's `processLocally` (on-device speech) where it's installed, for privacy.
- [ ] Never test posting against HN from Rounak's account without asking first.

## Open questions for Rounak

1. Publish the companion extension (Chrome and Firefox first)? It's the one-tap path on desktop.
2. A native wrapper for phones, later?
3. Should replies to you also reach you while the page is closed (web push)? That needs a server-side watch keyed
   by HN username, which is still public data, but it would be the first per-user state we keep.
