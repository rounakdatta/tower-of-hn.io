// The tables behind spoken.ts, from real Hacker News comments (200,000 of them, 19 days to 24 Nov 2026), each spoken
// form checked against what espeak-ng (Kokoro's reader) actually says. Grow them from `tools/speech-report.ts`, which
// lists the most frequent hosts and names in live comments that are not here yet.
//
// Letters to spell are written with spaces ("W S J") and joined at load (`letters`): espeak takes a lone "A" for the
// article ("uh W S"), so a spelled name is one hyphenated word ("W-S-J"), with "Eh" for an A after its first letter
// ("F-Eh-Eh"); spelled that way espeak says every letter.
export { WORDS } from './spoken-words.ts';

/** "W S J" "W-S-J", "F A A" "F-Eh-Eh": runs of single capitals (two or more) as one word espeak spells right */
export const letters = (s: string) => s.indexOf(' ') < 0 ? s : s.replace(/(?<![\w'’-])[A-Z](?: [A-Z](?![\w'’-]))+/g,
  (run) => run.split(' ').map((l, i) => (i && l === 'A' ? 'Eh' : l)).join('-'));
const lettered = <T extends Record<string, string>>(o: T) => { for (const k in o) (o as Record<string, string>)[k] = letters(o[k]); return o; };

/**
 * Sites people name rather than read out, ranked by how many threads link them. "+Name": a platform, "a Name link"
 * ("a GitHub link"), whatever the page. "=phrase": what such a link is ("an archived copy"). "@Name": a part of a
 * site with a name of its own ("the Arch wiki"). Any other site is its domain, said the way people say it (LABELS):
 * "N Y Post dot com". A subdomain finds its site ("en.wikipedia.org" is wikipedia.org).
 */
const RAW: Record<string, string> = {
  'github.com': '+GitHub', 'githubusercontent.com': '+GitHub', 'github.io': '+GitHub Pages', 'wikipedia.org': '+Wikipedia',
  'wiktionary.org': '+Wiktionary', 'wikimedia.org': '+Wikimedia', 'wikidata.org': '+Wikidata', 'wikiwand.com': '+Wikipedia', 'youtube.com': '+YouTube',
  'youtu.be': '+YouTube', 'x.com': '+X', 'twitter.com': '+Twitter', 'twimg.com': '+X', 'xcancel.com': '+X', 'nitter.net': '+X', 'reddit.com': '+Reddit',
  'redd.it': '+Reddit', 'archive.ph': '=an archived copy', 'archive.is': '=an archived copy', 'archive.today': '=an archived copy',
  'archive.li': '=an archived copy', 'archive.md': '=an archived copy', 'web.archive.org': '=an archived copy', 'archive.org': '+Internet Archive',
  'arxiv.org': '=an archive paper', 'alphaxiv.org': '=an archive paper', 'biorxiv.org': '=a bio-archive paper', 'medrxiv.org': '=a med-archive paper',
  'xkcd.com': '=an X K C D comic', 'huggingface.co': '+Hugging Face', 'ncbi.nlm.nih.gov': '+PubMed', 'anthropic.com': '+Anthropic',
  'claude.ai': '+Claude', 'claude.com': '+Claude', 'imgur.com': '+Imager', 'amazon.com': '+Amazon', 'amzn.to': '+Amazon', 'a.co': '+Amazon',
  'aboutamazon.com': '+Amazon', 'aws.amazon.com': '+A W S', 'hn.algolia.com': '=a Hacker News search', 'finance.yahoo.com': '@Yahoo Finance',
  'yahoo.com': '+Yahoo', 'google.com': '+Google', 'share.google': '+Google', 'docs.google.com': '+Google Docs', 'drive.google.com': '+Google Drive',
  'maps.google.com': '+Google Maps', 'maps.app.goo.gl': '+Google Maps', 'goo.gl': '+Google', 'play.google.com': '+Google Play',
  'patents.google.com': '+Google Patents', 'books.google.com': '+Google Books', 'groups.google.com': '+Google Groups',
  'scholar.google.com': '+Google Scholar', 'support.google.com': '+Google', 'gemini.google': '+Gemini', 'gemini.google.com': '+Gemini',
  'aistudio.google.com': '+Google AI Studio', 'cloud.google.com': '+Google Cloud', 'chromewebstore.google.com': '@the Chrome Web Store',
  'one.google.com': '+Google One', 'bsky.app': '+Bluesky', 'codeberg.org': '+Codeberg', 'microsoft.com': '+Microsoft', 'cloud.microsoft': '+Microsoft',
  'microsoft.ai': '+Microsoft', 'windows.com': '+Microsoft', 'azure.microsoft.com': '+Azure', 'sciencedirect.com': '+ScienceDirect',
  'openai.com': '+OpenAI', 'chatgpt.com': '+ChatGPT', 'goodreads.com': '+Goodreads', 'medium.com': '+Medium', 'linkedin.com': '+LinkedIn',
  'doi.org': '+D O I', 'developer.mozilla.org': '+M D N', 'mozilla.org': '+Mozilla', 'bugzilla.mozilla.org': '+Bugzilla',
  'addons.mozilla.org': '+Firefox add-ons', 'openrouter.ai': '+OpenRouter', 'acm.org': '+A C M', 'apple.com': '+Apple', 'developer.apple.com': '+Apple',
  'apps.apple.com': '@the App Store', 'support.apple.com': '+Apple Support', 'discussions.apple.com': '+Apple', 'testflight.apple.com': '+TestFlight',
  'lesswrong.com': '+LessWrong', 'blog.cloudflare.com': '@the Cloudflare blog', 'cloudflare.com': '+Cloudflare', 'imdb.com': '+I M D B',
  'fred.stlouisfed.org': '+FRED', 'pastebin.com': '+Pastebin', 'springer.com': '+Springer', 'steampowered.com': '+Steam',
  'steamcommunity.com': '+Steam', 'msn.com': '+M S N', 'nvidia.com': '+Nvidia', 'gitlab.com': '+GitLab', 'instagram.com': '+Instagram',
  'researchgate.net': '+ResearchGate', 'law.cornell.edu': '+Cornell Law', 'godbolt.org': '+Godbolt', 'statista.com': '+Statista',
  'duckduckgo.com': '+DuckDuckGo', 'ssrn.com': '+S S R N', 'abcnews.go.com': '@A B C News', 'oracle.com': '+Oracle',
  'paulgraham.com': '=a Paul Graham essay', 'sagepub.com': '+Sage', 'ec.europa.eu': '@the European Commission',
  'commission.europa.eu': '@the European Commission', 'eur-lex.europa.eu': '+EUR-Lex', 'rust-lang.org': '+Rust', 'doc.rust-lang.org': '+Rust docs',
  'ibb.co': '=an image', 'postimg.cc': '=an image', 'news.mit.edu': '@M I T News', 'wordpress.com': '+WordPress', 'ubuntu.com': '+Ubuntu',
  'lore.kernel.org': '@the kernel mailing list', 'rfc-editor.org': '=an R F C', 'ietf.org': '=an I E T F document', 'facebook.com': '+Facebook',
  'fb.com': '+Facebook', 'meta.com': '+Meta', 'lobste.rs': '+Lobsters', 'f-droid.org': '+F-Droid', 'cambridge.org': '+Cambridge', 'vimeo.com': '+Vim-ee-oh',
  'intel.com': '+Intel', 'ebay.com': '+eBay', 'openlibrary.org': '+Open Library', 'kagi.com': '+Kagi', 'zulipchat.com': '+Zulip',
  'wiki.archlinux.org': '@the Arch wiki', 'archlinux.org': '+Arch Linux', 'substack.com': '+Substack', 'debian.org': '+Debian', 'cve.org': '+C V E',
  'mastodon.social': '+Mastodon', 'spotify.com': '+Spotify', 'spacex.com': '+SpaceX', 'discord.gg': '+Discord', 'discord.com': '+Discord',
  'wiley.com': '+Wiley', 'oreilly.com': "+O'Reilly", 'scribd.com': '+Scribd', 'spectrum.ieee.org': '@I triple E Spectrum', 'ieee.org': '+I triple E',
  'stackoverflow.com': '+Stack Overflow', 'stackexchange.com': '+Stack Exchange', 'superuser.com': '+Super User', 'serverfault.com': '+Server Fault',
  'askubuntu.com': '+Ask Ubuntu', 'pypi.org': '+pie P I', 'docs.python.org': '@the Python docs', 'python.org': '+Python',
  'peps.python.org': '=a Python pep', 'sqlite.org': '+S Q Lite', 'tumblr.com': '+Tumblr', 'oup.com': '+Oxford Academic',
  'cppreference.com': '+C P P reference', 'moddb.com': '+Mod D B', 'ibm.com': '+IBM', 'tandfonline.com': '+Taylor and Francis',
  'man.openbsd.org': '=an Open B S D man page', 'openreview.net': '+OpenReview', 'hub.docker.com': '+Docker Hub', 'docker.com': '+Docker',
  'amd.com': '+AMD', 'polymarket.com': '+Polymarket', 'tiktok.com': '+TikTok', 'gutenberg.org': '+Project Gutenberg', 'frame.work': '+Framework',
  'nautil.us': '@Nautilus', 'semanticscholar.org': '+Semantic Scholar', 'jstor.org': '+J store',
  'plato.stanford.edu': '@the Stanford Encyclopedia of Philosophy', 'npmjs.com': '+N P M', 'pkg.go.dev': '+Go package', 'go.dev': '+Go',
  'nodejs.org': '+Node J S', 'chromium.org': '+Chromium', 'webkit.org': '+WebKit', 'git-scm.com': '+Git', 'man7.org': '=a man page',
  'nixos.org': '+NixOS', 'apache.org': '+Apache', 'postgresql.org': '+Post-gress', 'redis.io': '+Reddis', 'mongodb.com': '+MongoDB',
  'duckdb.org': '+DuckDB', 'kubernetes.io': '+Kubernetes', 'hashicorp.com': '+HashiCorp', 'vercel.com': '+Vercel', 'netlify.com': '+Netlify',
  'heroku.com': '+Heroku', 'digitalocean.com': '+DigitalOcean', 'hetzner.com': '+Hetzner', 'backblaze.com': '+Backblaze', 'tailscale.com': '+Tailscale',
  'signal.org': '+Signal', 'telegram.org': '+Telegram', 't.me': '+Telegram', 'matrix.org': '+Matrix', 'proton.me': '+Proton',
  'fastmail.com': '+Fastmail', 'brave.com': '+Brave', 'bing.com': '+Bing', 'perplexity.ai': '+Perplexity', 'mistral.ai': '+Mistral',
  'deepseek.com': '+DeepSeek', 'x.ai': '+X A I', 'courtlistener.com': '+CourtListener', 'gog.com': '+G O G', 'itch.io': '+itch dot I O',
  'twitch.tv': '+Twitch', 'patreon.com': '+Patreon', 'kickstarter.com': '+Kickstarter', 'producthunt.com': '+Product Hunt',
  'indiehackers.com': '+Indie Hackers', 'crunchbase.com': '+Crunchbase', 'glassdoor.com': '+Glassdoor', 'fandom.com': '+Fandom',
  'soundcloud.com': '+SoundCloud', 'bandcamp.com': '+Bandcamp', 'aliexpress.com': '+AliExpress', 'craigslist.org': '+Craigslist',
  'zillow.com': '+Zillow', 'airbnb.com': '+Air B N B', 'tesla.com': '+Tesla', 'asia.nikkei.com': '@Nikkei Asia',
  'timesofindia.indiatimes.com': '@the Times of India', 'economictimes.indiatimes.com': '@the Economic Times', 'zed.dev': '+Zed',
  'amazon.co.uk': '+Amazon', 'amazon.de': '+Amazon', 'amazon.ca': '+Amazon', 'amazon.in': '+Amazon', 'amazon.fr': '+Amazon', 'amazon.co.jp': '+Amazon',
  'threads.com': '+Threads', 'threads.net': '+Threads', 'cursor.com': '+Cursor', 'grok.com': '+Grok', 'wheresyoured.at': "@Where's Your Ed At",
  'fasterthanli.me': '@faster than lime',
};
export interface Site { name: string; platform?: boolean; phrase?: string }
export const SITES: Record<string, Site> = Object.fromEntries(Object.entries(RAW).map(([h, v]) => [h, v[0] === '+' ? { name: letters(v.slice(1)), platform: true }
  : v[0] === '=' ? { name: letters(v.slice(1)).replace(/^an? /, ''), phrase: letters(v.slice(1)) } : { name: letters(v.slice(1)) }]));

/**
 * A domain's name as people say it, for the sites linked most: "nypost" is "N Y Post" ("N Y Post dot com"),
 * "arstechnica" "Ars Technica". Any other name is split into words (spoken.ts `segment`).
 */
const LABEL_RAW: Record<string, string> = {
  github: 'GitHub', theguardian: 'the Guardian', nytimes: 'N Y Times', reuters: 'Reuters', wsj: 'W S J', bloomberg: 'Bloomberg', bbc: 'BBC',
  cnbc: 'CNBC', nature: 'Nature', ycombinator: 'Y Combinator', npr: 'NPR', arstechnica: 'Ars Technica', deepmind: 'DeepMind',
  artificialanalysis: 'Artificial Analysis', ourworldindata: 'Our World in Data', tomshardware: "Tom's Hardware", businessinsider: 'Business Insider',
  cbsnews: 'CBS News', ft: 'F T', theregister: 'the Register', forbes: 'Forbes', sec: 'S E C', techcrunch: 'TechCrunch', nbcnews: 'NBC News',
  newsweek: 'Newsweek', science: 'Science', apnews: 'A P News', knowyourmeme: 'Know Your Meme', cnn: 'CNN', latimes: 'L A Times', phoronix: 'Phoronix',
  wired: 'Wired', washingtonpost: 'Washington Post', abc: 'A B C', politico: 'Politico', fortune: 'Fortune', 'merriam-webster': 'Merriam-Webster',
  theverge: 'the Verge', pnas: 'P N A S', simonwillison: 'Simon Willison', cbc: 'C B C', economist: 'Economist', nypost: 'N Y Post',
  pewresearch: 'Pew Research', theatlantic: 'the Atlantic', scientificamerican: 'Scientific American', epoch: 'Epoch', danluu: 'Dan Luu', dw: 'D W',
  abcnews: 'A B C News', thehill: 'the Hill', time: 'Time', astralcodexten: 'Astral Codex Ten', slatestarcodex: 'Slate Star Codex', metr: 'Meter',
  eff: 'E F F', lwn: 'L W N', euronews: 'Euronews', nber: 'N B E R', futurism: 'Futurism', grapheneos: 'GrapheneOS', iea: 'I E A',
  macrotrends: 'Macrotrends', propublica: 'ProPublica', electrek: 'Electrek', gnu: 'G N U', pbs: 'P B S', europa: 'Europa',
  bleepingcomputer: 'Bleeping Computer', who: 'W H O', pcmag: 'P C Mag', asahilinux: 'Asahi Linux', faa: 'F A A', gizmodo: 'Gizmodo', mit: 'M I T',
  cmu: 'C M U', stanford: 'Stanford', berkeley: 'Berkeley', harvard: 'Harvard', utexas: 'U Texas', whitehouse: 'White House', eia: 'E I A',
  cdc: 'C D C', vice: 'Vice', nasa: 'NASA', quantamagazine: 'Quanta Magazine', daringfireball: 'Daring Fireball', sciencealert: 'ScienceAlert',
  aljazeera: 'Al Jazeera', quoteinvestigator: 'Quote Investigator', newyorker: 'New Yorker', irs: 'I R S', unsloth: 'Unsloth',
  globalnews: 'Global News', jamanetwork: 'JAMA Network', heise: 'Hy-zeh', theconversation: 'the Conversation', newrepublic: 'New Republic',
  usenix: 'Usenix', techdirt: 'Techdirt', w3: 'W3', gallup: 'Gallup', macrumors: 'MacRumors', semianalysis: 'SemiAnalysis',
  downdetector: 'Downdetector', phrack: 'Phrack', sciencedaily: 'ScienceDaily', openwrt: 'Open W R T', terrytao: 'Terry Tao', axios: 'Axios',
  gao: 'G A O', semafor: 'Semafor', a16z: 'A-sixteen-Z', acoup: 'a coo', cmegroup: 'C M E Group', dwarkesh: 'Dwarkesh', zerohedge: 'Zero Hedge',
  cell: 'Cell', '404media': '404 Media', krebsonsecurity: 'Krebs on Security', scmp: 'S C M P', thetimes: 'the Times', openbsd: 'Open B S D',
  freebsd: 'Free B S D', privacyguides: 'Privacy Guides', datacenterdynamics: 'Data Center Dynamics', 'lean-lang': 'Lean Lang',
  smithsonianmag: 'Smithsonian Mag', thelancet: 'the Lancet', investopedia: 'Investopedia', techpowerup: 'TechPowerUp', techspot: 'TechSpot',
  eurogamer: 'Eurogamer', cybernews: 'Cybernews', atlasobscura: 'Atlas Obscura', hackaday: 'Hackaday', fastcompany: 'Fast Company', ign: 'I G N',
  dailymail: 'Daily Mail', federalreserve: 'Federal Reserve', wccftech: 'W C C F Tech', gsmarena: 'G S M Arena', exponentialview: 'Exponential View',
  reason: 'Reason', opensecrets: 'OpenSecrets', vox: 'Vox', slate: 'Slate', salon: 'Salon', theintercept: 'the Intercept', engadget: 'Engadget',
  zdnet: 'ZDNet', venturebeat: 'VentureBeat', '9to5mac': 'nine to five Mac', '9to5google': 'nine to five Google', androidpolice: 'Android Police',
  anandtech: 'AnandTech', servethehome: 'ServeTheHome', howtogeek: 'How-To Geek', slashdot: 'Slashdot', aeon: 'Aeon', noemamag: 'Noema Mag',
  stratechery: 'Stratechery', cnet: 'C net', britannica: 'Britannica', etymonline: 'Etymonline', caniuse: 'Can I Use',
  theinformation: 'the Information', platformer: 'Platformer', restofworld: 'Rest of World', technologyreview: 'Technology Review', esa: 'E S A',
  noaa: 'NOAA', nih: 'N I H', fda: 'F D A', ftc: 'F T C', fcc: 'F C C', supremecourt: 'Supreme Court', federalregister: 'Federal Register',
  bls: 'B L S', worldbank: 'World Bank', imf: 'I M F', oecd: 'O E C D', un: 'U N', kotaku: 'Kotaku', polygon: 'Polygon', pcgamer: 'P C Gamer',
  rockpapershotgun: 'Rock Paper Shotgun', tvtropes: 'TV Tropes', nhtsa: 'N H T S A', ntsb: 'N T S B', newscientist: 'New Scientist',
  sciencenews: 'Science News', phys: 'Fizz', eurekalert: 'EurekAlert', statnews: 'Stat News', nejm: 'N E J M', bmj: 'B M J', marketwatch: 'MarketWatch',
  barrons: "Barron's", qz: 'Q Z', hbr: 'H B R', mckinsey: 'McKinsey', usatoday: 'USA Today', nbc: 'NBC', foxnews: 'Fox News', msnbc: 'MSNBC',
  independent: 'Independent', telegraph: 'Telegraph', spiegel: 'Spee-gull', lemonde: 'Le Monde', nikkei: 'Nikkei', japantimes: 'Japan Times',
  theglobeandmail: 'the Globe and Mail', smh: 'S M H', rnz: 'R N Z', thehindu: 'the Hindu', indianexpress: 'Indian Express',
  hindustantimes: 'Hindustan Times', livemint: 'Live Mint', bostonglobe: 'Boston Globe', sfchronicle: 'S F Chronicle', sfgate: 'S F Gate',
  chicagotribune: 'Chicago Tribune', seattletimes: 'Seattle Times', texastribune: 'Texas Tribune', motherjones: 'Mother Jones',
  nationalreview: 'National Review', thefp: 'the F P', jacobin: 'Jacobin', rollingstone: 'Rolling Stone', variety: 'Variety',
  hollywoodreporter: 'Hollywood Reporter', nme: 'N M E', theonion: 'the Onion', babylonbee: 'Babylon Bee', snopes: 'Snopes', politifact: 'PolitiFact',
  factcheck: 'FactCheck', wikileaks: 'WikiLeaks', bellingcat: 'Bellingcat', caranddriver: 'Car and Driver', thefirmwarehub: 'the Firmware Hub',
  usnews: 'U S News', brookings: 'Brookings', epa: 'E P A', nsa: 'N S A', rottentomatoes: 'Rotten Tomatoes', martinfowler: 'Martin Fowler',
  joelonsoftware: 'Joel on Software', sebastianraschka: 'Sebastian Raschka', jeffgeerling: 'Jeff Geerling', noahpinion: 'Noah-pinion',
  scottaaronson: 'Scott Aaronson', xeiaso: 'Zee Yahso', drewdevault: 'Drew DeVault', jvns: 'J V N S', rachelbythebay: 'Rachel by the Bay',
  overreacted: 'Overreacted', kalzumeus: 'Kalzumeus', marginalrevolution: 'Marginal Revolution', thenewstack: 'the New Stack', tagesschau: 'Tah-gess-shau',
  zeit: 'Tsite', faz: 'F A Z', sueddeutsche: 'Zood-doytsheh', nrc: 'N R C', yle: 'Ooleh', svt: 'S V T', nrk: 'N R K', rte: 'R T E',
  irishtimes: 'Irish Times', elpais: 'El Pah-ees', corriere: 'Korry-air-eh', kyivindependent: 'Kyiv Independent', meduza: 'Meduza',
  themoscowtimes: 'the Moscow Times', timesofisrael: 'Times of Israel', haaretz: 'Haaretz', straitstimes: 'Straits Times',
  channelnewsasia: 'Channel News Asia', koreaherald: 'Korea Herald', taipeitimes: 'Taipei Times', caixinglobal: 'Caixin Global',
  sixthtone: 'Sixth Tone', theprint: 'the Print', scroll: 'Scroll', thewire: 'the Wire', moneycontrol: 'Moneycontrol', inc42: 'Inc42',
  yourstory: 'YourStory', medianama: 'MediaNama', entrackr: 'Entrackr', 'the-ken': 'the Ken',
};
export const LABELS = new Map(Object.entries(LABEL_RAW).map(([k, v]) => [k, letters(v)]));

/** How people say a top-level domain. Anything else of two letters is spelled ("dot D E"). */
export const TLDS: Record<string, string> = lettered({
  com: 'com', org: 'org', net: 'net', edu: 'E D U', gov: 'gov', mil: 'mil', int: 'int', io: 'I O', ai: 'A I', dev: 'dev', app: 'app', co: 'co',
  me: 'me', tv: 'T V', fm: 'F M', sh: 'S H', ly: 'L Y', is: 'is', so: 'S O', to: 'to', rs: 'R S', gg: 'G G', xyz: 'X Y Z', info: 'info', biz: 'biz',
  blog: 'blog', news: 'news', page: 'page', site: 'site', tech: 'tech', club: 'club', social: 'social', art: 'art', wiki: 'wiki', cloud: 'cloud',
  online: 'online', website: 'website', space: 'space', zone: 'zone', works: 'works', systems: 'systems', guru: 'guru', one: 'one', run: 'run',
  build: 'build', studio: 'studio', land: 'land', world: 'world', life: 'life', live: 'live', email: 'email', link: 'link', ink: 'ink', lol: 'lol',
  fyi: 'F Y I', pub: 'pub', moe: 'moe', computer: 'computer', software: 'software', digital: 'digital', network: 'network', science: 'science',
  academy: 'academy', foundation: 'foundation', company: 'company', inc: 'inc', ltd: 'limited', tools: 'tools', codes: 'codes', engineering: 'engineering',
  in: 'in', uk: 'U K', us: 'U S', ca: 'C A', de: 'D E', fr: 'F R', jp: 'J P', au: 'A U', eu: 'E U', nl: 'N L', se: 'S E', no: 'N O', ch: 'C H',
  es: 'E S', it: 'I T', cn: 'C N', ru: 'R U', br: 'B R', at: 'A T', be: 'B E', dk: 'D K', fi: 'F I', nz: 'N Z', ie: 'I E', pl: 'P L', cz: 'C Z',
  kr: 'K R', tw: 'T W', hk: 'H K', sg: 'S G', il: 'I L', za: 'Z A', mx: 'M X', ar: 'A R', ch2: '', cc: 'C C', ws: 'W S', la: 'L A', ge: 'G E',
  am: 'A M', st: 'S T', im: 'I M', md: 'M D', ms: 'M S', nu: 'N U', pw: 'P W', re: 'R E', sx: 'S X', vc: 'V C', gd: 'G D', ac: 'A C', ag: 'A G',
});
/** Two-label endings that are suffixes, not names: "bbc.co.uk" is the BBC on co.uk; "foo.github.io" is foo on github.io */
export const SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'govt.nz', 'co.jp', 'ac.jp', 'or.jp', 'ne.jp', 'co.in', 'gov.in', 'ac.in', 'org.in', 'net.in', 'com.br', 'gov.br', 'com.cn',
  'com.tw', 'com.hk', 'com.sg', 'gov.sg', 'co.za', 'co.kr', 'co.il', 'ac.il', 'com.mx', 'com.ar', 'github.io', 'gitlab.io', 'pages.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'blogspot.com', 'wordpress.com', 'substack.com', 'tumblr.com', 'neocities.org', 'bearblog.dev', 'fly.dev',
  'web.app', 'firebaseapp.com', 'appspot.com', 'workers.dev', 'readthedocs.io', 'sourceforge.net', 'medium.com', 'zulipchat.com', 'mataroa.blog']);

/** Units after a number: [one, many]. Said only right after a number; plain ones only when glued to it ("5m" is
 *  meters or millions, "5 in" is a preposition), see UNIT_SPACED. */
export const UNITS: Record<string, [string, string]> = {
  KB: ['kilobyte', 'kilobytes'], kB: ['kilobyte', 'kilobytes'], MB: ['megabyte', 'megabytes'], GB: ['gigabyte', 'gigabytes'], TB: ['terabyte', 'terabytes'],
  PB: ['petabyte', 'petabytes'], EB: ['exabyte', 'exabytes'], kb: ['kilobyte', 'kilobytes'], mb: ['megabyte', 'megabytes'], gb: ['gigabyte', 'gigabytes'],
  tb: ['terabyte', 'terabytes'], KiB: ['kibibyte', 'kibibytes'], MiB: ['mebibyte', 'mebibytes'], GiB: ['gibibyte', 'gibibytes'], TiB: ['tebibyte', 'tebibytes'],
  Mb: ['megabit', 'megabits'], Gb: ['gigabit', 'gigabits'], Tb: ['terabit', 'terabits'], Kbps: ['kilobits per second', 'kilobits per second'],
  kbps: ['kilobits per second', 'kilobits per second'], Mbps: ['megabits per second', 'megabits per second'], Gbps: ['gigabits per second', 'gigabits per second'],
  Tbps: ['terabits per second', 'terabits per second'], 'Mbit/s': ['megabits per second', 'megabits per second'], 'Gbit/s': ['gigabits per second', 'gigabits per second'],
  'MB/s': ['megabytes per second', 'megabytes per second'], 'GB/s': ['gigabytes per second', 'gigabytes per second'], 'TB/s': ['terabytes per second', 'terabytes per second'],
  ms: ['millisecond', 'milliseconds'], µs: ['microsecond', 'microseconds'], us: ['microsecond', 'microseconds'], ns: ['nanosecond', 'nanoseconds'],
  sec: ['second', 'seconds'], secs: ['second', 'seconds'], min: ['minute', 'minutes'], mins: ['minute', 'minutes'], hr: ['hour', 'hours'], hrs: ['hour', 'hours'],
  h: ['hour', 'hours'], yr: ['year', 'years'], yrs: ['year', 'years'], wk: ['week', 'weeks'], wks: ['week', 'weeks'], mo: ['month', 'months'],
  Hz: ['hertz', 'hertz'], kHz: ['kilohertz', 'kilohertz'], KHz: ['kilohertz', 'kilohertz'], MHz: ['megahertz', 'megahertz'], GHz: ['gigahertz', 'gigahertz'],
  THz: ['terahertz', 'terahertz'], nm: ['nanometer', 'nanometers'], µm: ['micrometer', 'micrometers'], mm: ['millimeter', 'millimeters'],
  cm: ['centimeter', 'centimeters'], km: ['kilometer', 'kilometers'], mi: ['mile', 'miles'], ft: ['foot', 'feet'], kg: ['kilogram', 'kilograms'],
  mg: ['milligram', 'milligrams'], lb: ['pound', 'pounds'], lbs: ['pound', 'pounds'], oz: ['ounce', 'ounces'], W: ['watt', 'watts'], kW: ['kilowatt', 'kilowatts'],
  MW: ['megawatt', 'megawatts'], GW: ['gigawatt', 'gigawatts'], TW: ['terawatt', 'terawatts'], Wh: ['watt hour', 'watt hours'], kWh: ['kilowatt hour', 'kilowatt hours'],
  MWh: ['megawatt hour', 'megawatt hours'], GWh: ['gigawatt hour', 'gigawatt hours'], TWh: ['terawatt hour', 'terawatt hours'], V: ['volt', 'volts'],
  kV: ['kilovolt', 'kilovolts'], mV: ['millivolt', 'millivolts'], mA: ['milliamp', 'milliamps'], mAh: ['milliamp hour', 'milliamp hours'],
  Ah: ['amp hour', 'amp hours'], mph: ['mile per hour', 'miles per hour'], kph: ['kilometer per hour', 'kilometers per hour'],
  'km/h': ['kilometer per hour', 'kilometers per hour'], '°C': ['degree Celsius', 'degrees Celsius'], '°F': ['degree Fahrenheit', 'degrees Fahrenheit'],
  '°': ['degree', 'degrees'], px: ['pixel', 'pixels'], LOC: ['line of code', 'lines of code'], 'tok/s': ['token per second', 'tokens per second'],
  't/s': ['token per second', 'tokens per second'], 'tokens/s': ['token per second', 'tokens per second'], 'tokens/sec': ['token per second', 'tokens per second'],
};
/** units that may stand a space away from their number ("32 GB"); the rest must be glued to it ("24h") */
export const UNIT_SPACED = new Set(Object.keys(UNITS).filter((u) => !['h', 'us', 'mo', 'mi', 'min', 'V', 'W', 'oz', 'ft', 'kb', 'mb', 'gb', 'tb', 'µs', '°'].includes(u)));

/** Nouns that make a number before them a count ("10M users", "300K tokens"): K and B are otherwise letters */
export const COUNT_NOUNS = new Set(`users people persons customers subscribers followers stars views downloads installs visitors employees workers jobs
lines loc tokens parameters params weights rows records requests queries files words pages books copies units devices phones cars vehicles homes
houses deaths cases votes voters members developers devs engineers programmers students kids children adults years hours days months weeks
minutes seconds miles dollars euros pounds rupees yen barrels tons tonnes acres transactions messages emails calls sales accounts apps repos
repositories commits issues prs comments posts tweets items products games songs videos images photos samples examples points citizens
residents troops soldiers positions patients doctors nurses teachers readers listeners viewers players gamers papers articles stories sites
websites domains servers machines nodes cores threads gpus cpus chips transistors cells neurons genes species animals birds trees bytes bits ops
operations instructions cycles iterations steps epochs layers experts documents entries keys objects packages dependencies libraries crates
modules functions tests bugs vulnerabilities stars forks likes upvotes signups orders licenses seats subscriptions households families companies
startups businesses firms banks lives jobs immigrants refugees cattle chickens pigs dogs cats followers fans members contributors maintainers
contracts shares options miles kilometers meters feet barrels gallons liters calories steps visits hits clicks impressions requests rps qps
connections sessions downloads streams plays subscribers inhabitants visitors tourists passengers flights trips rides orders meals`.split(/\s+/));

/**
 * Capitals espeak reads as a word that people spell ("OP" is not "op", "NYC" not "nick", "ROI" not "roy"), found by
 * reading every capitalised name of the sample through espeak and comparing it with its letters; and a few said in
 * words. Plurals ("LLMs", "GPUs": espeak drops the s) are spelled by rule (spoken.ts). Each checked through espeak.
 */
export const ACRONYMS: Record<string, string> = lettered({
  OP: 'O P', UX: 'U X', IPO: 'I P O', CLI: 'C L I', AWS: 'A W S', AGI: 'A G I', CI: 'C I', OSS: 'O S S', IDE: 'I D E', NYC: 'N Y C', ROI: 'R O I',
  FAA: 'F A A', SWE: 'S W E', QA: 'Q A', IQ: 'I Q', YC: 'Y C', EV: 'E V', SEO: 'S E O', VRAM: 'V RAM', DRAM: 'D RAM', OAI: 'O A I', CA: 'C A',
  AAA: 'triple A', IO: 'I O', POV: 'P O V', ASI: 'A S I', XYZ: 'X Y Z', SEC: 'S E C', IC: 'I C', PII: 'P I I', IR: 'I R', YT: 'YouTube', OG: 'O G',
  LOC: 'L O C', AA: 'A A', OOP: 'O O P', AP: 'A P', EA: 'E A', TOS: 'T O S', UBI: 'U B I', LEO: 'L E O', GOP: 'G O P', ISA: 'I S A', IPC: 'I P C',
  ABI: 'A B I', SI: 'S I', UPS: 'U P S', ATC: 'A T C', KYC: 'K Y C', ASML: 'A S M L', EUV: 'E U V', IA: 'I A', CYA: 'C Y A', BYD: 'B Y D', AOT: 'A O T',
  AOSP: 'A O S P', AV: 'A V', AR: 'A R', OOM: 'O O M', ETA: 'E T A', QED: 'Q E D', OTP: 'O T P', ISS: 'I S S', ARR: 'A R R', ORM: 'O R M', AG: 'A G',
  UAE: 'U A E', SA: 'S A', ERP: 'E R P', USG: 'U S G', UB: 'U B', ULA: 'U L A', ETF: 'E T F', BLE: 'B L E', AST: 'A S T', EPA: 'E P A', MCU: 'M C U',
  APK: 'A P K', ECC: 'E C C', OIDC: 'O I D C', ASN: 'A S N', ECS: 'E C S', OSM: 'O S M', NGO: 'N G O', COO: 'C O O', CFAA: 'C F A A', SAP: 'S A P',
  TSA: 'T S A', IDF: 'I D F', PTO: 'P T O', ICU: 'I C U', IVF: 'I V F', ADB: 'A D B', PID: 'P I D', HID: 'H I D', GIS: 'G I S', ESL: 'E S L',
  ETL: 'E T L', PTA: 'P T A', AWD: 'A W D', AOC: 'A O C', EOF: 'E O F', DEI: 'D E I', AMA: 'A M A', SME: 'S M E', ADR: 'A D R', IG: 'I G', GA: 'G A',
  EOL: 'E O L', USP: 'U S P', ICC: 'I C C', ASR: 'A S R', HOA: 'H O A', LUT: 'L U T', BEV: 'B E V', UGC: 'U G C', SOP: 'S O P', OSI: 'O S I',
  YTD: 'Y T D', OBS: 'O B S', OCI: 'O C I', FDIC: 'F D I C', DJI: 'D J I', AVR: 'A V R', PLA: 'P L A', EC: 'E C', IPS: 'I P S', UA: 'U A',
  ATS: 'A T S', DOA: 'D O A', EGA: 'E G A', GHA: 'G H A', EKS: 'E K S', AUM: 'A U M', AAC: 'A A C', AIO: 'A I O', USC: 'U S C', ATF: 'A T F',
  UAC: 'U A C', EMI: 'E M I', ACA: 'A C A', EMS: 'E M S', CLA: 'C L A', ROC: 'R O C', IDP: 'I D P', OTA: 'O T A', SPI: 'S P I', WAF: 'W A F',
  ACP: 'A C P', USAF: 'U S A F', DUV: 'D U V', AAPL: 'A A P L', TSLA: 'T S L A', AMZN: 'A M Z N', CICD: 'C I C D', EV: 'E V', ESR: 'E S R',
  PA: 'P A', UE: 'U E', EE: 'E E', DOD: 'D O D', POC: 'P O C', ECU: 'E C U', OOB: 'O O B', ESA: 'E S A', ACL: 'A C L', GE: 'G E', NIH: 'N I H',
  USDC: 'U S D C', PO: 'P O', PE: 'P E', CEC: 'C E C', QAT: 'Q A T', JMAP: 'J map', BIS: 'B I S', NHTSA: 'N H T S A',
  OVH: 'O V H', MITM: 'M I T M', IPFS: 'I P F S', IRL: 'I R L', ESP32: 'E S P 32', II: 'two', III: 'three', WWII: 'World War Two',
  WW2: 'World War Two', WWI: 'World War One', WW1: 'World War One', IPv4: 'I P v4', IPv6: 'I P v6', CO2: 'C O 2', IoT: 'I O T', YoY: 'year over year',
  MoM: 'month over month', QoQ: 'quarter over quarter', PhD: 'P H D', PhDs: 'P H Dees', SaaS: 'sass', PaaS: 'pass', IaaS: 'I A A S', DDoS: 'D doss',
  ELI5: "explain like I'm five", TIL: 'today I learned', 'TL;DR': 'T L D R', 'TL,DR': 'T L D R',
});

/** Capitals espeak says as a word (right or not): their plural or possessive is said the same way, in lower case,
 *  which espeak reads with its s ("ARM's" "arm's"; "ARM's" itself loses the s). Found by reading each through espeak. */
export const SAID_AS_WORDS = new Set(`RAM IIRC NOT AND IMHO EDIT NVIDIA FWIW AFAIK README FOSS IS LOT ARM SOTA THE LOL ALL JSON OR NO IME CUDA COVID TUI IF YMMV LED AGENTS YOU
DOS THAT ISO NASA AT BUT IDK SO TO GNU ICE DO UNIX AFAICT VERY ANT ASAP CRUD WASM JIT ANY DOGE RIP FUD THIS FAANG NATO FAQ MAGA STEM RAG
FOMO REALLY ONE RE OF SIMD AKA WHY ONLY BASIC MUCH REST NOW PITA NEVER MORE MUST EUR ARE CAN AM ME SE IN WAY BE FOR POSIX YOLO ON WILL
CLAUDE ASCII OLED FAR SOC CSAM ETH BIOS IOW COBOL PI IANAL HVAC YOUR AD METR OT SCOTUS DID HUGE IV ALWAYS MY EULA NIMBY ZIRP LISP AF SHOULD
SRAM THEY WIP TODO MR PIN GNOME POTUS GOOD SPA MIDI IMAP IAM WHAT NEED LEAN SMART BY NAT SAAS VA MANY JIRA AS REA NES YAML HAVE AIUI GPUI EM
NAND YES BIG QEMU DDOS ASM ALSO ET WAS TIME WHO UPDATE NASDAQ POS EVERY DEC LOVE WINE TWO HA ONNX CERN GOAT WORK ZERO HAS TI WANT DE WITH CE
WOW COULD IKEA LE TAM JUST THEN GET DOES SAT MAC ARC MAX COM SUPER RIGHT OTHER GEO ICBM GIMP LMAO POST NA MOST DKIM DMARC AU SELECT WAN NULL
WE CMOS ANSI HOW BOM FLOSS RISC WA EVEN ADE DOT GOS RAII YEARS NUC TON GGUF SOL STILL RHEL ADC THEIR VAT ALU CO AB USAID ACM OO ICANN REAL
BEFORE HIPAA MIPS EPYC OMP XOR MAD FIRE THERE LOTS GREAT TOTP SNES FREE GPIO PLEASE FAST SATA SIP OLD CISA CANNOT ITAR DAG PIP MOE LEGO GAAP
CAM IOT KISS BI ST MIGHT SOME ES PRISM ESP DGAF NOTE AFAIR LONG STOP GO DOOM UART EQ SCSI HEAD ELF LDAP PRO SES ZIP WHERE COGS USPS ASP OH
CLOUD THINK DAYJOB GPUS PER NEW SAM WWIII FROM JEPA ARTEX GOOG BOTH APL ITT OFF OUR SOLID HARD RBAC NIST THING SYSTEM DOWN EVER TA OC POTS
XX ER NUMA YET META ABOUT SPARC SOAP NVDIA ASUS RAW TIA BEAM MAI USE GOG BACK WIRED WAL HAL MAU PARC WCAG BETTER OPEC IM JEV LARP START UP
YEAR LESS IMDB VLAN DRY AFAIU SAN CORS NEC SKILL SPARK DOE AFTER DNSSEC DATA FOO OWN ACE ABS SEA WHOLE SPAM NAME NOAA DARPA NOBODY ATT CHINA
MEAN VAX GOTO PIO OUT MO IDEA SAY BRICS WIFI STEP PAC WOULD SAD SRI FLOP TEE EMF FUSE NAFTA DROP AIM ISIS MOS FUCK FAFO BAD NGINX RU EBITDA
AIDS VOIP OPM ACPI DA SAME ERROR SICP FULL READ QUIC FIFA IYKYK BERT SERP COTS INSANE LAMP CNAME PFAS ASEAN DIN VIP POWER FIRST XAML GOFAI
JOB WHICH CHIPS FISA ACT HE PLAN LI EPIC THEM KNEW SMIC FAIR MAKE SIL PAY SHIFT WHEN AN TODAY FIDO ANYONE LIDAR PAT HUMANS CATL APFS UC CTRL
USPTO ELSE IL NOTAM DUI HATE IEA OOT ISDN GRE ACME ZRAM MIR HUMAN OWL NEXT LOOK PIC CISO SET HIGH FE JTAG RA PET RIAA TONS FU MU ACH QWERTY
SBOM BYOK AMC JAX AGENT EMC AZ ACTUAL RFID NE SAR EACH TOR DI HUD PAM FIFO NET DIMM SPY AJAX EXACT SPEC SUNO FINE LOCAL IDGAF KIM USING
USENET RDIMM PUT ITS`.split(/\s+/));

/** Spoken forms of names and jargon espeak gets wrong (case as written). Checked one by one against espeak. */
export const SAY: Record<string, string> = lettered({
  kubectl: 'kube control', k8s: 'Kubernetes', K8s: 'Kubernetes', JSON: 'Jason', CUDA: 'cooda', 'RISC-V': 'risk five', LaTeX: 'lah-tek', TeX: 'tek',
  PyPI: 'pie P I', Deno: 'dee-no', 'C#': 'C sharp', 'F#': 'F sharp', PostgreSQL: 'Post-gress Q L', Postgres: 'Post-gress', postgres: 'post-gress',
  arXiv: 'archive', Arxiv: 'archive', arxiv: 'archive', Qwen: 'Kwen', Huawei: 'Wah-way', Xiaomi: 'Shao-mee', Amodei: 'Ah-mo-day', Nadella: 'Nah-della',
  Xi: 'Shee', Airbnb: 'Air B N B', Hyprland: 'Hyper-land', etcd: 'E T C D', rustc: 'rust C', ESLint: 'E S lint', Redis: 'Reddis', 'x86-64': 'x86 64',
  'x86_64': 'x86 64', 'Node.js': 'Node J S', 'Next.js': 'Next J S', 'Vue.js': 'Vue J S', 'llama.cpp': 'llama dot C P P', 'whisper.cpp': 'whisper dot C P P', Clojure: 'Closure',
});
/** Abbreviations however they're cased ("imo", "IMO"), said in full */
export const SAY_CI: Record<string, string> = lettered({
  imo: 'in my opinion', imho: 'in my humble opinion', imnsho: 'in my not so humble opinion', iirc: 'if I recall correctly', afaik: 'as far as I know',
  afaict: 'as far as I can tell', afaics: 'as far as I can see', afair: 'as far as I remember', fwiw: "for what it's worth", ymmv: 'your mileage may vary',
  ianal: 'I am not a lawyer', otoh: 'on the other hand', iiuc: 'if I understand correctly', aiui: 'as I understand it',
  iow: 'in other words', idk: "I don't know", ofc: 'of course', btw: 'by the way', tbh: 'to be honest', ngl: 'not gonna lie', icymi: 'in case you missed it',
  ftfy: 'fixed that for you', tfa: 'the article', aka: 'also known as', tldr: 'T L D R', 'tl;dr': 'T L D R', 'e.g': 'for example', 'i.e': 'that is',
  vs: 'versus', approx: 'approximately', wrt: 'with respect to', irl: 'I R L', istm: 'it seems to me', tia: 'thanks in advance', ime: 'in my experience', imx: 'in my experience',
});
