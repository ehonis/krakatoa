/*
 * Krakatoa — build content/restaurants.json from each chain's OWN nutrition data.
 *
 *   node scripts/restaurants.build.mjs            # every chain
 *   node scripts/restaurants.build.mjs culvers    # just these; the rest are kept as they are
 *
 * WHY THIS EXISTS AND NOT AN API. There is no free source for chain menus any
 * more (see server/nutritionix.js and AGENTS.md §3e for what was checked). But a
 * chain in the US with 20+ locations is REQUIRED to publish its nutrition, so
 * every chain here is read from what the chain itself publishes, and the
 * document and its date travel with the menu as the receipt. Same arrangement as
 * the basics catalog: content generated from a primary source, never typed.
 *
 * The chains publish six different ways, so there are six readers, and each
 * says in its own header what it reads and how it checks itself:
 *
 *   bbox-pdf         Bibibop    a PDF whose names wrap; read by word coordinates,
 *                               checked against the ingredient cards on their site
 *   rows-pdf         Chipotle   a PDF of one-line rows; checked against the same
 *                               PDF's front page, which prints the calories again
 *   nutritionix-inm  Culver's   the hosted menu file their own nutrition guide loads
 *   mcd-archive      McDonald's their calculator's own data, as the Internet
 *                               Archive captured it (mcdonalds.com blocks scripts)
 *   panera-pdf       Panera     their per-cycle nutrition guide PDF, as the Archive
 *                               captured it; checked against its own fat columns
 *   balance-archive  Balance    their old menu site's published numbers (July 2025),
 *                               as the Archive kept it; two city menus must agree
 *
 * Everything after a reader is here: ids, the energy sanity check, failing the
 * build on a cross-check that disagrees, and the one output shape.
 *
 * A restaurant under 20 locations is not required to publish nutrition, and
 * most do not, so it cannot be here. Build its dishes as combos from the basics.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { atwaterOutliers, slug } from './restaurants/common.mjs'
import * as bboxPdf from './restaurants/bbox-pdf.mjs'
import * as rowsPdf from './restaurants/rows-pdf.mjs'
import * as nutritionix from './restaurants/nutritionix-inm.mjs'
import * as mcdArchive from './restaurants/mcd-archive.mjs'
import * as paneraPdf from './restaurants/panera-pdf.mjs'
import * as balanceArchive from './restaurants/balance-archive.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'content', 'restaurants.json')

/*
 * A chain is either a BOWL — built from parts, step by step, and named after
 * what went in it ("Chipotle · Chicken burrito") — or an ORDER, picked off a
 * menu of whole things ("McDonald's · Big Mac + French Fries, Medium").
 *
 * A step can say:
 *   increment  how far one tap moves it (a base goes in halves)
 *   split      a second pick halves the first — two bases is a split bowl
 *   names      its picks name the bowl (the protein does)
 *   vessel     its picks decide what the bowl IS — a burrito tortilla makes a burrito
 *   collapsed  folded until opened; for the long tail nobody scrolls past twice
 *   extra      alongside the bowl, not in it — chips and a drink do not make a bowl
 */
const CHAINS = [
  /* ----------------------------------------------------------- Chipotle */
  {
    id: 'chipotle',
    reader: rowsPdf,
    name: 'Chipotle Mexican Grill',
    short: 'Chipotle',
    kind: 'bowl',
    vessel: 'bowl',
    pdf: 'https://www.chipotle.com/content/dam/chipotle/menu/nutrition/US-Nutrition-Facts-Paper-Menu-3-2025.pdf',
    published: '2024-10-16', // the PDF's own creation date; its file name says 3-2025
    source: { what: "Chipotle's nutrition PDF", dateWord: 'dated' },
    note: 'Every portion is the standard scoop. Double meat is two of it; "light" or "extra" of anything else is not a portion Chipotle publishes, so it is not offered.',
    skipFrom: /^\s*kids menu\s*$/i,
    resumeAt: /^Flour Tortilla \(burrito\)$/,
    frontAliases: { fajitaveggies: 'Fajita Vegetables', cilantrolimerice: 'Cilantro-Lime White Rice' },
    steps: [
      { id: 'start', label: 'Burrito, tacos or salad', hint: 'Skip it for a bowl', vessel: true },
      { id: 'rice', label: 'Rice', increment: 0.5, split: true, hint: 'Two halves for half and half' },
      { id: 'beans', label: 'Beans', increment: 0.5, split: true },
      { id: 'protein', label: 'Protein', names: true, hint: 'Twice for double' },
      { id: 'salsa', label: 'Salsa & dressing' },
      { id: 'toppings', label: 'Toppings' },
      { id: 'sides', label: 'Sides', extra: true },
      { id: 'drinks', label: 'Drink', collapsed: true, extra: true },
    ],
    // Every food row in the PDF, placed. A new one fails the build until it is.
    rows: {
      flourtortillaburrito: { item: 'Flour Tortilla', step: 'start', category: 'Tortillas & greens', portion: 'Burrito', vessel: 'burrito' },
      flourtortillataco: { item: 'Flour Tortilla', step: 'start', category: 'Tortillas & greens', portion: 'Taco', vessel: 'tacos' },
      crispycorntortilla: { item: 'Crispy Corn Tortilla', step: 'start', category: 'Tortillas & greens', portion: 'Taco', vessel: 'tacos' },
      supergreenssaladmix: { item: 'Supergreens Salad Mix', step: 'start', category: 'Tortillas & greens', vessel: 'salad' },
      cilantrolimewhiterice: { step: 'rice', category: 'Rice' },
      cilantrolimebrownrice: { step: 'rice', category: 'Rice' },
      blackbeans: { step: 'beans', category: 'Beans' },
      pintobeans: { step: 'beans', category: 'Beans' },
      chicken: { step: 'protein', category: 'Proteins' },
      steak: { step: 'protein', category: 'Proteins' },
      barbacoa: { step: 'protein', category: 'Proteins' },
      carnitas: { step: 'protein', category: 'Proteins' },
      sofritas: { step: 'protein', category: 'Proteins' },
      freshtomatosalsa: { step: 'salsa', category: 'Salsas' },
      roastedchilicornsalsa: { step: 'salsa', category: 'Salsas' },
      tomatillogreenchilisalsa: { step: 'salsa', category: 'Salsas' },
      tomatilloredchilisalsa: { step: 'salsa', category: 'Salsas' },
      chipotlehoneyvinaigrette: { step: 'salsa', category: 'Dressing' },
      fajitavegetables: { step: 'toppings', category: 'Toppings' },
      cheese: { step: 'toppings', category: 'Toppings' },
      sourcream: { step: 'toppings', category: 'Toppings' },
      romainelettucetacos: { item: 'Romaine Lettuce', step: 'toppings', category: 'Toppings' },
      // One row, two things he orders: guac IN the bowl, and guac on the side.
      guacamoletoppingside: [
        { item: 'Guacamole', step: 'toppings', category: 'Toppings' },
        { item: 'Side of Guacamole', step: 'sides', category: 'Sides', portion: 'Side' },
      ],
      guacamolelarge: { item: 'Side of Guacamole', step: 'sides', category: 'Sides', portion: 'Large' },
      quesoblancoentree: { item: 'Queso Blanco', step: 'toppings', category: 'Toppings' },
      quesoblancoside: { item: 'Side of Queso Blanco', step: 'sides', category: 'Sides', portion: 'Side' },
      quesoblancolarge: { item: 'Side of Queso Blanco', step: 'sides', category: 'Sides', portion: 'Large' },
      chipsregular: { item: 'Chips', step: 'sides', category: 'Sides', portion: 'Regular' },
      chipslarge: { item: 'Chips', step: 'sides', category: 'Sides', portion: 'Large' },
    },
  },

  /* ------------------------------------------------------------ Bibibop */
  {
    id: 'bibibop',
    reader: bboxPdf,
    name: 'Bibibop Asian Grill',
    short: 'Bibibop',
    kind: 'bowl',
    pdf: 'https://bibibop.com/wp-content/uploads/2026/09/BIBIBOP-Nutrition-Updated-8.19.26.pdf',
    published: '2026-08-19',
    source: { what: "Bibibop's nutrition PDF", dateWord: 'updated' },
    page: 'https://www.bibibop.com/nutrition/',
    /*
     * Where the web page and the PDF name the same thing differently. Explicit
     * rather than a looser fuzzy match: the cross-check is only worth something
     * if a name it cannot place FAILS.
     */
    pageAliases: { cagefreeegg: 'Eggs', organictofu: 'Tofu' },
    note: 'Numbers are for an original-sized bowl. A bibiCup is half a base; Bibibop does not publish a smaller portion of anything else, so nothing else is halved.',
    // bibiCup: "THE BASE CALORIES FOR BIBICUP = ½ PORTIONS", from the PDF's own header.
    sizes: [
      { id: 'bowl', label: 'Bowl', vessel: 'bowl', scale: {} },
      { id: 'cup', label: 'bibiCup', vessel: 'bibiCup', scale: { base: 0.5 } },
    ],
    sections: {
      BASES: { category: 'Bases', step: 'base' },
      PROTEIN: { category: 'Proteins', step: 'protein' },
      'HOT TOPPINGS': { category: 'Hot toppings', step: 'toppings' },
      'COLD TOPPINGS': { category: 'Cold toppings', step: 'toppings' },
      SAUCE: { category: 'Sauces', step: 'sauce' },
      SIDES: { category: 'Sides', step: 'extras' },
      DESSERTS: { category: 'Desserts', step: 'extras' },
      'COKE BEVERAGES': { category: 'Drinks', step: 'drinks', serving: '20 fl oz cup' },
      'TEAS & LEMONADES': { category: 'Drinks', step: 'drinks', serving: '20 fl oz cup' },
      'HONEST KIDS JUICE': { category: 'Drinks', step: 'drinks' },
      'HEALTH ADE KOMBUCHA': { category: 'Drinks', step: 'drinks' },
    },
    steps: [
      { id: 'base', label: 'Base', hint: 'Pick one, or two halves', increment: 0.5, split: true },
      { id: 'protein', label: 'Protein', names: true },
      { id: 'toppings', label: 'Toppings' },
      { id: 'sauce', label: 'Sauce' },
      { id: 'extras', label: 'Sides & dessert', extra: true },
      { id: 'drinks', label: 'Drink', collapsed: true, extra: true },
    ],
  },

  /* ------------------------------------------------------------ Culver's */
  {
    id: 'culvers',
    reader: nutritionix,
    name: "Culver's",
    short: "Culver's",
    kind: 'order',
    slug: 'culvers',
    page: 'https://www.culvers.com/nutrition-and-allergen-guide',
    source: { what: "Culver's own nutrition guide", dateWord: 'updated' },
    note: 'Sizes are Culver’s own. A sandwich is as it comes; a change to it (no cheese, add bacon) is not a portion they publish here.',
    skipCategories: ['Test and LTOs (Preview Only)'],
    categories: {
      ButterBurgers: { category: 'ButterBurgers', step: 'mains' },
      'Chicken & Sandwiches': { category: 'Chicken & sandwiches', step: 'mains' },
      'Seafood & Salads': { category: 'Seafood, dinners & salads', step: 'mains' },
      Sides: { category: 'Sides', step: 'sides' },
      'Fresh Frozen Custard': { category: 'Frozen custard', step: 'dessert' },
      'Lemon Ice': { category: 'Lemon ice', step: 'dessert' },
      Drinks: { category: 'Drinks', step: 'drinks' },
    },
    steps: [
      { id: 'mains', label: 'Burgers, chicken & dinners' },
      { id: 'sides', label: 'Sides' },
      { id: 'dessert', label: 'Custard & lemon ice', collapsed: true },
      { id: 'drinks', label: 'Drinks', collapsed: true },
    ],
  },

  /* ---------------------------------------------------------- McDonald's */
  {
    id: 'mcdonalds',
    reader: mcdArchive,
    name: "McDonald's",
    short: "McDonald's",
    kind: 'order',
    archiveFrom: '2024',
    onlyCore: true,
    source: { what: "McDonald's own nutrition data, as archived by the Internet Archive", dateWord: 'captured up to' },
    note: 'mcdonalds.com refuses anything but a browser, so these are McDonald’s own figures as the Internet Archive captured them from its nutrition calculator. The newest copy of each item wins. Anything they have changed since is not here, and the menu is only as complete as what was captured.',
    skipNames: [/\bNo Ice\b/i, /\bMeal\b/i],
    nameAliases: { Fries: 'French Fries', 'Latte Iced Caramel': 'Iced Caramel Latte', 'Latte Iced': 'Iced Latte', 'Honest Kids Appley Ever After (Box 6 fl oz Drink Box)': 'Honest Kids Appley Ever After juice box' },
    guessCategory: [
      [/coffee|latte|mocha|frappe|cappuccino|americano|macchiato|smoothie|espresso/i, 'McCafé'],
      [/sauce|dressing|ketchup|syrup|jam|butter|jelly/i, 'Condiments'],
      [/mcmuffin|mcgriddle|biscuit|hotcake|hash brown|burrito|breakfast|oatmeal|big breakfast/i, 'Breakfast'],
      [/nugget|mccrispy|chicken|strips|filet-o-fish|fish/i, 'Chicken and Sandwiches'],
      [/burger|quarter pounder|big mac|big arch|mcdouble|daily double|cheeseburger/i, 'Burgers'],
      [/fries|apple slices/i, 'Snacks & Sides'],
      [/shake|mcflurry|cone|sundae|cookie|pie/i, 'Desserts & Shakes'],
      [/coke|coca-cola|sprite|fanta|pepper|tea|lemonade|water|milk|juice|oz|energizer|hi-c|powerade/i, 'Beverages'],
    ],
    categories: {
      Breakfast: { category: 'Breakfast', step: 'breakfast' },
      Burgers: { category: 'Burgers', step: 'mains' },
      'Chicken and Sandwiches': { category: 'Chicken & fish', step: 'mains' },
      'Chicken & Fish Sandwiches': { category: 'Chicken & fish', step: 'mains' },
      'McNuggets and Meals': { category: 'Chicken & fish', step: 'mains' },
      'Snacks & Sides': { category: 'Fries & sides', step: 'sides' },
      'Fries & Sides': { category: 'Fries & sides', step: 'sides' },
      'Desserts & Shakes': { category: 'Desserts & shakes', step: 'dessert' },
      Sweets: { category: 'Desserts & shakes', step: 'dessert' },
      McCafé: { category: 'McCafé', step: 'drinks' },
      'McCafé Coffees': { category: 'McCafé', step: 'drinks' },
      Beverages: { category: 'Drinks', step: 'drinks' },
      Condiments: { category: 'Sauces', step: 'sauces' },
      'Sauces & Condiments': { category: 'Sauces', step: 'sauces' },
    },
    steps: [
      { id: 'mains', label: 'Burgers, chicken & fish' },
      { id: 'sides', label: 'Fries & sides' },
      { id: 'breakfast', label: 'Breakfast', collapsed: true },
      { id: 'sauces', label: 'Sauces', collapsed: true },
      { id: 'dessert', label: 'Desserts & shakes', collapsed: true },
      { id: 'drinks', label: 'Drinks & McCafé', collapsed: true },
    ],
  },
  /* -------------------------------------------------------------- Panera */
  {
    id: 'panera',
    reader: paneraPdf,
    name: 'Panera Bread',
    short: 'Panera',
    kind: 'order',
    // The guide for menu cycle 6 of 2026, "Effective: 6/17/2026", as the Archive
    // captured it on 2026-07-21. panerabread.com itself refuses scripts. When a
    // newer cycle appears (c7-26, …) in the Archive, point this at it:
    //   curl 'https://web.archive.org/cdx/search/cdx?url=www.panerabread.com/content/dam/panerabread/documents/&matchType=prefix&output=json&filter=original:.*nutrition-guide.*'
    pdf: 'https://web.archive.org/web/20260721205557id_/https://www.panerabread.com/content/dam/panerabread/documents/c6-26-nutrition-guide.pdf',
    published: '2026-06-17',
    source: { what: "Panera's own nutrition guide, as archived by the Internet Archive", dateWord: 'effective' },
    note: 'panerabread.com refuses anything but a browser, so this is Panera’s own PDF guide as the Internet Archive saved it. Fountain drinks are the in-store pour; at the drive-thru there is more ice and fewer calories. A You Pick 2 is a half sandwich or salad and a cup of soup — pick each.',
    skipNames: [/^Drive[- ]Thru\b/i],
    sections: {
      SANDWICHES: { category: 'Sandwiches', step: 'sandwiches' },
      'SOUPS & MAC': { category: 'Soups & mac', step: 'soups', rename: [[/\s+Soup\b/g, '']] },
      'SALADS & STUFFERS': { category: 'Salads & stuffers', step: 'salads' },
      'MARKET BOWLS': { category: 'Market bowls', step: 'salads', rename: [[/^Market Bowl\s*-\s*/i, '']] },
      SIDES: { category: 'Sides', step: 'sides', rename: [[/^Side\s*-\s*/i, ''], [/\s*-\s*Side Portion$/i, '']] },
      BREAKFAST: { category: 'Breakfast', step: 'breakfast' },
      'BAGELS & SPREADS': { category: 'Bagels & spreads', step: 'bakery' },
      BREADS: { category: 'Breads', step: 'bakery', rename: [[/^Bread Portion\s*-\s*/i, '']] },
      'PASTRIES & SWEETS': {
        category: 'Pastries & sweets',
        step: 'sweets',
        rename: [
          [/\s*-\s*Naturally Flavored$/i, ''],
          [/Twists 2\s*-\s*Pack$/i, 'Twists'],
          [/^(Cookie|Muffin|Muffie|Mini Scone|Scone)\s*-\s*(.+)$/i, '$2 $1'],
          [/^Pastry\s*-\s*(\w+)$/i, '$1 Pastry'],
          [/^Pastry\s*-\s*/i, ''],
        ],
      },
      'DRESSINGS/SAUCES/SPREADS': {
        category: 'Dressings & sauces',
        step: 'sauces',
        // "Dressing - Greek Dressing - Sandwich Portion" and "Dressing Greek" are
        // the same dressing in two portions.
        rename: [[/^(Sauce|Dressing|Spread)\s*-?\s*/i, ''], [/\s*-\s*Portion(?=\s*(-|$))/i, ''], [/\s+Dressing\b/i, '']],
      },
      DRINKS: { category: 'Drinks', step: 'drinks' },
      KIDS: null, // the same sandwiches, soups and mac as the main menu, again
      CATERING: null,
      'GRAB N GO': null,
    },
    steps: [
      { id: 'sandwiches', label: 'Sandwiches' },
      { id: 'soups', label: 'Soups & mac' },
      { id: 'salads', label: 'Salads & bowls' },
      { id: 'sides', label: 'Sides' },
      { id: 'breakfast', label: 'Breakfast', collapsed: true },
      { id: 'bakery', label: 'Bagels & bread', collapsed: true },
      { id: 'sweets', label: 'Pastries & sweets', collapsed: true },
      { id: 'sauces', label: 'Dressings & sauces', collapsed: true },
      { id: 'drinks', label: 'Drinks', collapsed: true },
    ],
  },
  /* ------------------------------------------------ Balance Pan-Asian Grille */
  {
    id: 'balance',
    reader: balanceArchive,
    name: 'Balance Pan-Asian Grille',
    short: 'Balance',
    kind: 'bowl',
    vessel: 'bowl',
    // balance.menu's compiled page script, last captured by the Archive 2025-07-21.
    // Found by searching the Archive for balance.menu after balancegrille.com's
    // /nutrition/ came back 404; see the reader's header.
    archive: 'https://web.archive.org/web/20250721193201id_/https://balance.menu/static/js/main.c0fcd673.chunk.js',
    published: '2025-07-21',
    source: { what: "Balance's own published nutrition (balance.menu), as the Internet Archive kept it", dateWord: 'captured' },
    note: 'Balance stopped publishing nutrition; these are its own figures from July 2025, and the menu has changed since (crispy chicken, poppers and the salads have no published numbers). A bowl here is its sauce and vegetables only — add a protein and a starch, as you do at the counter. No serving sizes were ever given.',
    steps: [
      { id: 'base', label: 'Bowl', names: true, hint: 'Sauce and vegetables — add a protein and a starch' },
      { id: 'protein', label: 'Protein', names: true, hint: 'Twice for double' },
      { id: 'starch', label: 'Starch', increment: 0.5, split: true, hint: 'Two halves for half and half' },
      { id: 'tacos', label: 'Tacos', extra: true },
      { id: 'snacks', label: 'Snacks', extra: true },
    ],
    rows: {
      greencurry: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      yumyum: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      budda: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      fourstar: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      wiseman: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      thaiguy: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      teriyaki: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      koreanbibimbap: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      sassyme: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      sweetsour: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      nuts4pao: { step: 'base', category: 'Bowls', portion: '1 bowl (sauce & vegetables)' },
      grilledchicken: { step: 'protein', category: 'Proteins', portion: '1 portion' },
      wokfiredsteak: { step: 'protein', category: 'Proteins', portion: '1 portion' },
      lentils: { step: 'protein', category: 'Proteins', portion: '1 portion' },
      tofu: { step: 'protein', category: 'Proteins', portion: '1 portion' },
      brownrice: { step: 'starch', category: 'Starches', portion: '1 portion' },
      whiterice: { step: 'starch', category: 'Starches', portion: '1 portion' },
      friedrice: { step: 'starch', category: 'Starches', portion: '1 portion' },
      wheatnoodles: { step: 'starch', category: 'Starches', portion: '1 portion' },
      freshgreens: { step: 'starch', category: 'Starches', portion: '1 portion' },
      koreanbbq: { step: 'tacos', category: 'Tacos', portion: '1 taco' },
      bangbang: { step: 'tacos', category: 'Tacos', portion: '1 taco' },
      mongo: { step: 'tacos', category: 'Tacos', portion: '1 taco' },
      soho: { step: 'tacos', category: 'Tacos', portion: '1 taco' },
      bangbangnachos: { step: 'snacks', category: 'Snacks', portion: '1 order' },
      edamame: { step: 'snacks', category: 'Snacks', portion: '1 order' },
      creamywontons: { step: 'snacks', category: 'Snacks', portion: '1 order' },
      citrusbrussels: { step: 'snacks', category: 'Snacks', portion: '1 order' },
      veggieeggroll: { step: 'snacks', category: 'Snacks', portion: '1 eggroll' },
      fivespicepoppers: { step: 'snacks', category: 'Snacks', portion: '1 order' },
    },
  },
]

/* -------------------------------------------------------------------- build */

const only = process.argv.slice(2)
const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { chains: [] }
const today = new Date().toISOString().slice(0, 10)

const chainsOut = []
let failed = false

for (const chain of CHAINS) {
  if (only.length && !only.includes(chain.id)) {
    const kept = previous.chains.find(c => c.id === chain.id)
    if (kept) { chainsOut.push(kept); console.log(`${chain.name}: kept as built ${kept.source?.built || '?'}`) }
    continue
  }

  const r = await chain.reader.read(chain)
  const seen = new Set()
  const items = r.items.map(it => {
    let id = `${chain.id}-${slug(`${it.category}-${it.name}`)}`
    while (seen.has(id)) id += '-x'
    seen.add(id)
    return {
      id,
      name: it.name,
      brand: chain.short,
      category: it.category,
      step: it.step,
      source: 'restaurant',
      portions: it.portions,
      defaultPortion: it.defaultPortion || it.portions[0]?.id,
      ...(it.capturedAt ? { capturedAt: `${it.capturedAt.slice(0, 4)}-${it.capturedAt.slice(4, 6)}-${it.capturedAt.slice(6, 8)}` } : {}),
    }
  })

  const stepIds = new Set(chain.steps.map(s => s.id))
  const stray = items.filter(i => !stepIds.has(i.step))
  if (stray.length) { failed = true; console.log(`  ${stray.length} items on a step the chain does not declare: ${stray.map(i => i.name).join(', ')}`) }

  console.log(`${chain.name}: ${items.length} items (${items.reduce((n, i) => n + i.portions.length, 0)} portions)`)
  const byCat = {}
  for (const i of items) byCat[i.category] = (byCat[i.category] || 0) + 1
  console.log('   ', Object.entries(byCat).map(([k, n]) => `${k} ${n}`).join(' · '))
  for (const c of r.checks) console.log(`    ✓ ${c}`)
  for (const w of atwaterOutliers(items)) console.log(`    ? ${w}`)
  if (r.unplaced.length) {
    // A PDF row nobody placed is a new menu item, or a misread one. Either way
    // it is the change worth stopping for.
    failed = true
    console.log(`  ${r.unplaced.length} rows NOT placed:`)
    for (const u of r.unplaced) console.log(`    ${u}`)
  }
  if (r.mismatches.length) {
    failed = true
    console.log(`  ${r.mismatches.length} MISMATCH(ES):`)
    for (const m of r.mismatches) console.log(`    ${m}`)
  }

  chainsOut.push({
    id: chain.id,
    name: chain.name,
    short: chain.short,
    kind: chain.kind,
    vessel: chain.vessel || null,
    note: chain.note,
    sizes: chain.sizes || null,
    steps: chain.steps,
    source: {
      ...chain.source,
      url: chain.pdf || chain.page || null,
      published: r.published || null,
      from: r.capturedFrom || null,
      built: today,
    },
    items,
  })
}

if (failed) {
  console.error('\nnot written: a reader and its cross-check disagree, or something is unplaced. Fix that before trusting either.')
  process.exit(1)
}

fs.writeFileSync(OUT, `${JSON.stringify({
  generatedAt: today,
  note: 'Generated by scripts/restaurants.build.mjs from each chain\'s own published nutrition data. Do not hand-edit.',
  chains: chainsOut,
}, null, 2)}\n`)
console.log(`\nwrote ${OUT}`)
