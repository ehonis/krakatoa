/*
 * Krakatoa — build content/basics.json from USDA SR Legacy.
 *
 *   node scripts/basics.build.mjs [--zip /tmp/fdc_sr.zip]
 *
 * The basics catalog is every generic food you would type rather than scan: an
 * egg, a tablespoon of butter, a cup of rice. It is CONTENT — a file on disk the
 * server reads — for exactly the reason Bushido's exercise catalog is: the list is
 * wrong the day it ships and adding to it should not need a rebuild.
 *
 * The numbers are NOT written by hand. USDA publishes SR Legacy as a bulk JSON
 * download (no API key, no rate limit, ~7,800 generic foods) carrying per-100g
 * nutrients AND household portions with their gram weights — which is the whole
 * reason this source was chosen over typing values from memory. "1 large egg" is
 * 50 g because USDA says so, and `fdcId` on every row is the receipt.
 *
 * Re-run it whenever the curated list below changes. It prints anything it could
 * not match so a bad matcher is loud rather than silently missing.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'content', 'basics.json')
const SOURCE_URL = 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip'

/* The nutrients we keep, by USDA number — the stable key. See nutrition.js. */
const NUTRIENTS = { 208: 'kcal', 203: 'protein', 205: 'carbs', 204: 'fat', 291: 'fiber', 269: 'sugar', 307: 'sodium' }

/*
 * Household measures worth offering, in the order they should appear. A USDA
 * food carries up to a dozen portions ("1 cup (4.86 large eggs)", "1 jumbo");
 * three or four recognizable ones is a picker you can aim with a thumb, and the
 * rest is noise. `100 g` is always appended, so anything weighable still logs.
 */
const UNIT_RANK = [
  'large', 'medium', 'small', 'slice', 'piece', 'whole', 'fillet', 'breast', 'thigh', 'link', 'patty',
  'cup', 'tbsp', 'tablespoon', 'tsp', 'teaspoon', 'fl oz', 'oz', 'scoop', 'packet', 'container', 'bottle', 'can',
  // Last: "1 serving" says nothing a cup does not, so it only leads where it is
  // all USDA gives (a can of Monster, a Rice Krispies Treat).
  'serving',
]

/*
 * The thing ITSELF, for foods that come as one: "1 doughnut oval", "1 cookie",
 * "1 sundae". Without these a donut offered only "1 oz", because every portion
 * USDA gives it is named after the donut rather than a unit. They rank WITH the
 * size words, not after the units: "1 doughnut" is the donut you ate, and
 * ranked last it lost to "1 doughnut, small" and even to "1 oz".
 */
const ITEM_NOUNS = [
  'doughnut', 'cruller', 'cookie', 'muffin', 'croissant', 'pastry', 'danish', 'roll', 'bun', 'bagel', 'biscuit',
  'waffle', 'pancake', 'bar', 'square', 'sandwich', 'item', 'each', 'sundae', 'drink', 'frankfurter',
  'hot dog', 'taco', 'burrito', 'egg roll', 'tortilla', 'pie', 'cake', 'package', 'envelope', 'sticks', 'strip',
  'pieces', 'drumstick', 'wing', 'inch sub', 'cupcake', 'pizza',
]
const NOUN_RANK = 3

/* What a portion of something tends to be. Used only to ORDER the portions a
   food offers — never to invent one. See portionsFor. */
const SERVING_KCAL = 180

const rankOf = (mod) => {
  const m = String(mod || '').toLowerCase()
  const hit = (u) => m === u || m.startsWith(`${u} `) || m.startsWith(`${u},`) || m.includes(` ${u}`)
  const i = UNIT_RANK.findIndex(hit)
  const noun = ITEM_NOUNS.some(hit) ? NOUN_RANK : 999
  return Math.min(i === -1 ? 999 : i, noun)
}

/** "1 large" / "2 tbsp" / "1 cup, chopped" -> a label that reads on a phone. */
function portionLabel(amount, modifier) {
  const mod = String(modifier || '').trim()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    // USDA's regulatory "NLEA serving" is just a serving to anyone reading it.
    .replace(/\bNLEA\s+/gi, '').replace(/\bServing\b/g, 'serving')
    .replace(/\s*\d+ pieces = serving$/i, '')
    // The name says "Donut"; the portion should not say "doughnut oval".
    .replace(/\bdoughnut oval\b/i, 'donut').replace(/\bdoughnut\b/gi, 'donut')
    // One spelling per unit. USDA uses "tablespoon" and "tbsp" interchangeably
    // across foods, which reads as two different measures on a picker.
    .replace(/\btablespoons?\b/gi, 'tbsp')
    .replace(/\bteaspoons?\b/gi, 'tsp')
    .replace(/\s+/g, ' ').trim()
  const a = Number(amount) || 1
  // "1 serving 9 servings per 24 oz package" -> "1/9 of a 24 oz package".
  const per = mod.match(/^serving,?\s+(\d+) servings? per (.+)$/i)
  if (per && a === 1) return per[1] === '1' ? `1 whole ${per[2]}` : `1/${per[1]} of a ${per[2]}`
  // "1 serving 1 cup", "1 serving 2.05 oz bar": the serving IS the measure after it.
  const inner = a === 1 && mod.match(/^serving,?\s+(\d.*)$/i)
  if (inner) return inner[1]
  // 'pizza 12" diameter' -> '1/4 of a 12" pizza'.
  const pie = mod.match(/^pizza (\d+)" diameter$/i)
  if (pie) return a === 1 ? `1 whole ${pie[1]}" pizza` : `${a === 0.25 ? '1/4' : a === 0.5 ? '1/2' : a} of a ${pie[1]}" pizza`
  if (!mod) return a === 1 ? 'serving' : `${a} servings`
  return a === 1 ? `1 ${mod}` : `${a} ${mod}`
}

/* --------------------------------------------------------------- the list */

/*
 * `match` is a case-insensitive prefix of the USDA description. Where several
 * match, the SHORTEST description wins — USDA qualifies the unusual variants at
 * length ("Butter, salted" vs "Butter, salted, whipped, with salt"), so short is
 * a good proxy for "the ordinary one". `avoid` rules out a shorter wrong match.
 */
const CATALOG = [
  /* ------------------------------------------------------- eggs and dairy */
  { c: 'Eggs & dairy', n: 'Egg, whole, raw', m: 'Egg, whole, raw, fresh' },
  { c: 'Eggs & dairy', n: 'Egg, scrambled', m: 'Egg, whole, cooked, scrambled' },
  { c: 'Eggs & dairy', n: 'Egg, fried', m: 'Egg, whole, cooked, fried' },
  { c: 'Eggs & dairy', n: 'Egg, hard-boiled', m: 'Egg, whole, cooked, hard-boiled' },
  { c: 'Eggs & dairy', n: 'Egg white, raw', m: 'Egg, white, raw, fresh' },
  { c: 'Eggs & dairy', n: 'Egg yolk, raw', m: 'Egg, yolk, raw, fresh' },
  { c: 'Eggs & dairy', n: 'Milk, whole', m: 'Milk, whole, 3.25% milkfat, with added vitamin D' },
  { c: 'Eggs & dairy', n: 'Milk, 2%', m: 'Milk, reduced fat, fluid, 2% milkfat, with added vitamin A and vitamin D' },
  { c: 'Eggs & dairy', n: 'Milk, skim', m: 'Milk, nonfat, fluid, with added vitamin A and vitamin D (fat free or skim)' },
  { c: 'Eggs & dairy', n: 'Almond milk, unsweetened', m: 'Beverages, almond milk, unsweetened, shelf stable' },
  { c: 'Eggs & dairy', n: 'Heavy cream', m: 'Cream, fluid, heavy whipping' },
  { c: 'Eggs & dairy', n: 'Half and half', m: 'Cream, fluid, half and half' },
  { c: 'Eggs & dairy', n: 'Greek yogurt, plain nonfat', m: 'Yogurt, Greek, plain, nonfat' },
  { c: 'Eggs & dairy', n: 'Greek yogurt, plain whole milk', m: 'Yogurt, Greek, plain, whole milk' },
  { c: 'Eggs & dairy', n: 'Yogurt, plain whole milk', m: 'Yogurt, plain, whole milk' },
  { c: 'Eggs & dairy', n: 'Cottage cheese, 2%', m: 'Cheese, cottage, lowfat, 2% milkfat' },
  { c: 'Eggs & dairy', n: 'Cheddar cheese', m: 'Cheese, cheddar', avoid: ['nonfat', 'fat free', 'Includes foods'] },
  { c: 'Eggs & dairy', n: 'Mozzarella cheese', m: 'Cheese, mozzarella, whole milk' },
  { c: 'Eggs & dairy', n: 'Parmesan cheese, grated', m: 'Cheese, parmesan, grated' },
  { c: 'Eggs & dairy', n: 'Cream cheese', m: 'Cheese, cream' },
  { c: 'Eggs & dairy', n: 'Feta cheese', m: 'Cheese, feta' },
  { c: 'Eggs & dairy', n: 'Swiss cheese', m: 'Cheese, swiss' },
  { c: 'Eggs & dairy', n: 'American cheese', m: 'Cheese, pasteurized process, American' },

  /* ------------------------------------------------------------ fats, oils */
  { c: 'Fats & oils', n: 'Butter, salted', m: 'Butter, salted' },
  { c: 'Fats & oils', n: 'Butter, unsalted', m: 'Butter, without salt' },
  { c: 'Fats & oils', n: 'Olive oil', m: 'Oil, olive, salad or cooking' },
  { c: 'Fats & oils', n: 'Canola oil', m: 'Oil, canola' },
  { c: 'Fats & oils', n: 'Coconut oil', m: 'Oil, coconut' },
  { c: 'Fats & oils', n: 'Vegetable oil', m: 'Oil, soybean, salad or cooking' },
  { c: 'Fats & oils', n: 'Mayonnaise', m: 'Salad dressing, mayonnaise, regular' },
  { c: 'Fats & oils', n: 'Avocado', m: 'Avocados, raw, all commercial varieties' },

  /* ---------------------------------------------------------- meat and fish */
  { c: 'Meat & fish', n: 'Chicken breast, roasted', m: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted' },
  { c: 'Meat & fish', n: 'Chicken breast, raw', m: 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw' },
  { c: 'Meat & fish', n: 'Chicken thigh, roasted', m: 'Chicken, broilers or fryers, thigh, meat only, cooked, roasted' },
  { c: 'Meat & fish', n: 'Ground beef, 90% lean, cooked', m: 'Beef, ground, 90% lean meat / 10% fat, patty, cooked, pan-broiled' },
  { c: 'Meat & fish', n: 'Ground beef, 80% lean, cooked', m: 'Beef, ground, 80% lean meat / 20% fat, patty, cooked, pan-broiled' },
  { c: 'Meat & fish', n: 'Steak, sirloin, grilled', m: 'Beef, loin, top sirloin filet, boneless, separable lean only, trimmed to 0" fat, all grades, cooked, grilled' },
  { c: 'Meat & fish', n: 'Pork chop, cooked', m: 'Pork, fresh, loin, center rib (chops), boneless, separable lean only, cooked, braised' },
  { c: 'Meat & fish', n: 'Bacon, cooked', m: 'Pork, cured, bacon, cooked, broiled, pan-fried or roasted' },
  { c: 'Meat & fish', n: 'Ground turkey, cooked', m: 'Turkey, ground, cooked' },
  { c: 'Meat & fish', n: 'Turkey breast, roasted', m: 'Turkey, whole, breast, meat only, cooked, roasted' },
  { c: 'Meat & fish', n: 'Salmon, cooked', m: 'Fish, salmon, Atlantic, farmed, cooked, dry heat' },
  { c: 'Meat & fish', n: 'Tuna, canned in water', m: 'Fish, tuna, light, canned in water, drained solids' },
  { c: 'Meat & fish', n: 'Tilapia, cooked', m: 'Fish, tilapia, cooked, dry heat' },
  { c: 'Meat & fish', n: 'Shrimp, cooked', m: 'Crustaceans, shrimp, cooked' },
  { c: 'Meat & fish', n: 'Deli turkey', m: 'Turkey breast, sliced, prepackaged' },
  { c: 'Meat & fish', n: 'Ham, sliced', m: 'Ham, sliced, pre-packaged, deli meat' },

  /* ----------------------------------------------------- grains and breads */
  { c: 'Grains & bread', n: 'White rice, cooked', m: 'Rice, white, long-grain, regular, enriched, cooked' },
  { c: 'Grains & bread', n: 'Brown rice, cooked', m: 'Rice, brown, long-grain, cooked' },
  { c: 'Grains & bread', n: 'Oats, dry', m: 'Cereals, oats, regular and quick, not fortified, dry' },
  { c: 'Grains & bread', n: 'Oatmeal, cooked', m: 'Cereals, oats, regular and quick, unenriched, cooked with water' },
  { c: 'Grains & bread', n: 'Pasta, cooked', m: 'Pasta, cooked, enriched, without added salt' },
  { c: 'Grains & bread', n: 'Whole wheat pasta, cooked', m: 'Pasta, whole-wheat, cooked' },
  { c: 'Grains & bread', n: 'Quinoa, cooked', m: 'Quinoa, cooked' },
  { c: 'Grains & bread', n: 'Bread, whole wheat', m: 'Bread, whole-wheat, commercially prepared', avoid: ['toasted'] },
  { c: 'Grains & bread', n: 'Bread, white', m: 'Bread, white, commercially prepared', avoid: ['toasted', 'low sodium'] },
  { c: 'Grains & bread', n: 'Bagel, plain', m: 'Bagels, plain, enriched, with calcium propionate' },
  { c: 'Grains & bread', n: 'English muffin', m: 'English muffins, plain, enriched' },
  { c: 'Grains & bread', n: 'Tortilla, flour', m: 'Tortillas, ready-to-bake or -fry, flour, refrigerated' },
  { c: 'Grains & bread', n: 'Tortilla, corn', m: 'Tortillas, ready-to-bake or -fry, corn' },
  { c: 'Grains & bread', n: 'Couscous, cooked', m: 'Couscous, cooked' },
  { c: 'Grains & bread', n: 'Cornflakes', m: 'Cereals ready-to-eat, RALSTON Corn Flakes' },
  { c: 'Grains & bread', n: 'Granola', m: 'Cereals ready-to-eat, granola, homemade' },
  { c: 'Grains & bread', n: 'Pancake', m: 'Pancakes, plain, prepared from recipe' },

  /* --------------------------------------------------------------- produce */
  { c: 'Fruit', n: 'Banana', m: 'Bananas, raw' },
  { c: 'Fruit', n: 'Apple', m: 'Apples, raw, with skin' },
  { c: 'Fruit', n: 'Orange', m: 'Oranges, raw, all commercial varieties' },
  { c: 'Fruit', n: 'Strawberries', m: 'Strawberries, raw' },
  { c: 'Fruit', n: 'Blueberries', m: 'Blueberries, raw' },
  { c: 'Fruit', n: 'Raspberries', m: 'Raspberries, raw' },
  { c: 'Fruit', n: 'Grapes', m: 'Grapes, red or green (European type, such as Thompson seedless), raw' },
  { c: 'Fruit', n: 'Watermelon', m: 'Watermelon, raw' },
  { c: 'Fruit', n: 'Pineapple', m: 'Pineapple, raw, all varieties' },
  { c: 'Fruit', n: 'Mango', m: 'Mangos, raw' },
  { c: 'Fruit', n: 'Peach', m: 'Peaches, yellow, raw' },
  { c: 'Fruit', n: 'Pear', m: 'Pears, raw' },
  { c: 'Fruit', n: 'Cherries', m: 'Cherries, sweet, raw' },
  { c: 'Fruit', n: 'Dates', m: 'Dates, medjool' },
  { c: 'Fruit', n: 'Raisins', m: 'Raisins, golden, seedless' },
  { c: 'Fruit', n: 'Lemon', m: 'Lemons, raw, without peel' },

  { c: 'Vegetables', n: 'Broccoli, raw', m: 'Broccoli, raw' },
  { c: 'Vegetables', n: 'Broccoli, cooked', m: 'Broccoli, cooked, boiled, drained, without salt' },
  { c: 'Vegetables', n: 'Spinach, raw', m: 'Spinach, raw' },
  { c: 'Vegetables', n: 'Kale, raw', m: 'Kale, raw' },
  { c: 'Vegetables', n: 'Carrots, raw', m: 'Carrots, raw' },
  { c: 'Vegetables', n: 'Tomato', m: 'Tomatoes, red, ripe, raw, year round average' },
  { c: 'Vegetables', n: 'Cucumber', m: 'Cucumber, with peel, raw' },
  { c: 'Vegetables', n: 'Bell pepper, red', m: 'Peppers, sweet, red, raw' },
  { c: 'Vegetables', n: 'Onion, raw', m: 'Onions, raw' },
  { c: 'Vegetables', n: 'Garlic', m: 'Garlic, raw' },
  { c: 'Vegetables', n: 'Mushrooms, raw', m: 'Mushrooms, white, raw' },
  { c: 'Vegetables', n: 'Potato, baked', m: 'Potatoes, russet, flesh and skin, baked' },
  { c: 'Vegetables', n: 'Sweet potato, baked', m: 'Sweet potato, cooked, baked in skin, flesh, without salt' },
  { c: 'Vegetables', n: 'Corn, cooked', m: 'Corn, sweet, yellow, cooked, boiled, drained, without salt' },
  { c: 'Vegetables', n: 'Green beans, cooked', m: 'Beans, snap, green, cooked, boiled, drained, without salt' },
  { c: 'Vegetables', n: 'Asparagus, cooked', m: 'Asparagus, cooked, boiled, drained' },
  { c: 'Vegetables', n: 'Zucchini', m: 'Squash, summer, zucchini, includes skin, raw' },
  { c: 'Vegetables', n: 'Cauliflower, raw', m: 'Cauliflower, raw' },
  { c: 'Vegetables', n: 'Lettuce, romaine', m: 'Lettuce, cos or romaine, raw' },
  { c: 'Vegetables', n: 'Peas, cooked', m: 'Peas, green, cooked, boiled, drained, without salt' },

  /* ------------------------------------------------------ beans and legumes */
  { c: 'Beans & legumes', n: 'Black beans, cooked', m: 'Beans, black, mature seeds, cooked, boiled, without salt' },
  { c: 'Beans & legumes', n: 'Chickpeas, cooked', m: 'Chickpeas (garbanzo beans, bengal gram), mature seeds, cooked, boiled, without salt' },
  { c: 'Beans & legumes', n: 'Lentils, cooked', m: 'Lentils, mature seeds, cooked, boiled, without salt' },
  { c: 'Beans & legumes', n: 'Kidney beans, cooked', m: 'Beans, kidney, all types, mature seeds, cooked, boiled, without salt' },
  { c: 'Beans & legumes', n: 'Pinto beans, cooked', m: 'Beans, pinto, mature seeds, cooked, boiled, without salt' },
  { c: 'Beans & legumes', n: 'Edamame, cooked', m: 'Edamame, frozen, prepared' },
  { c: 'Beans & legumes', n: 'Tofu, firm', m: 'Tofu, raw, firm, prepared with calcium sulfate' },
  { c: 'Beans & legumes', n: 'Hummus', m: 'Hummus, commercial' },

  /* --------------------------------------------------------- nuts and seeds */
  { c: 'Nuts & seeds', n: 'Almonds', m: 'Nuts, almonds', avoid: ['blanched', 'oil roasted', 'honey'] },
  { c: 'Nuts & seeds', n: 'Peanuts', m: 'Peanuts, all types, dry-roasted, without salt' },
  { c: 'Nuts & seeds', n: 'Walnuts', m: 'Nuts, walnuts, english' },
  { c: 'Nuts & seeds', n: 'Cashews', m: 'Nuts, cashew nuts, dry roasted, without salt added' },
  { c: 'Nuts & seeds', n: 'Pecans', m: 'Nuts, pecans' },
  { c: 'Nuts & seeds', n: 'Peanut butter', m: 'Peanut butter, smooth style, without salt' },
  { c: 'Nuts & seeds', n: 'Almond butter', m: 'Nuts, almond butter, plain, without salt added' },
  { c: 'Nuts & seeds', n: 'Chia seeds', m: 'Seeds, chia seeds, dried' },
  { c: 'Nuts & seeds', n: 'Sunflower seeds', m: 'Seeds, sunflower seed kernels, dry roasted, without salt' },
  { c: 'Nuts & seeds', n: 'Pumpkin seeds', m: 'Seeds, pumpkin and squash seed kernels, roasted, without salt' },

  /* ----------------------------------------------- condiments and sweeteners */
  { c: 'Condiments', n: 'Sugar, white', m: 'Sugars, granulated' },
  { c: 'Condiments', n: 'Brown sugar', m: 'Sugars, brown' },
  { c: 'Condiments', n: 'Honey', m: 'Honey' },
  { c: 'Condiments', n: 'Maple syrup', m: 'Syrups, maple' },
  { c: 'Condiments', n: 'Ketchup', m: 'Catsup' },
  { c: 'Condiments', n: 'Mustard', m: 'Mustard, prepared, yellow' },
  { c: 'Condiments', n: 'Soy sauce', m: 'Soy sauce made from soy and wheat (shoyu)' },
  { c: 'Condiments', n: 'Salsa', m: 'Sauce, salsa, ready-to-serve' },
  { c: 'Condiments', n: 'Ranch dressing', m: 'Salad dressing, ranch dressing, regular' },
  { c: 'Condiments', n: 'Barbecue sauce', m: 'Sauce, barbecue' },
  { c: 'Condiments', n: 'Hot sauce', m: 'Sauce, hot chile, sriracha' },
  { c: 'Condiments', n: 'Marinara sauce', m: 'Sauce, pasta, spaghetti/marinara, ready-to-serve' },
  { c: 'Condiments', n: 'Salt', m: 'Salt, table' },

  /* ----------------------------------------------------------------- drinks */
  { c: 'Drinks', n: 'Coffee, brewed', m: 'Beverages, coffee, brewed, prepared with tap water', avoid: ['decaffeinated', 'espresso'] },
  { c: 'Drinks', n: 'Espresso', m: 'Beverages, coffee, brewed, espresso, restaurant-prepared' },
  { c: 'Drinks', n: 'Tea, brewed', m: 'Beverages, tea, black, brewed, prepared with tap water', avoid: ['decaffeinated'] },
  { c: 'Drinks', n: 'Orange juice', m: 'Orange juice, raw' },
  { c: 'Drinks', n: 'Beer, regular', m: 'Alcoholic beverage, beer, regular, all' },
  { c: 'Drinks', n: 'Beer, light', m: 'Alcoholic beverage, beer, light' },
  { c: 'Drinks', n: 'Red wine', m: 'Alcoholic beverage, wine, table, red' },
  { c: 'Drinks', n: 'White wine', m: 'Alcoholic beverage, wine, table, white' },
  { c: 'Drinks', n: 'Whiskey / spirits', m: 'Alcoholic beverage, distilled, all (gin, rum, vodka, whiskey) 80 proof' },

  /* ------------------------------------------------------ snacks and sweets */
  { c: 'Snacks & sweets', n: 'Dark chocolate', m: 'Candies, dark chocolate' },
  { c: 'Snacks & sweets', n: 'Milk chocolate', m: 'Candies, milk chocolate' },
  { c: 'Snacks & sweets', n: 'Potato chips', m: 'Snacks, potato chips, plain, salted' },
  { c: 'Snacks & sweets', n: 'Tortilla chips', m: 'Snacks, tortilla chips, plain, white corn' },
  { c: 'Snacks & sweets', n: 'Pretzels', m: 'Snacks, pretzels, hard, plain, salted' },
  { c: 'Snacks & sweets', n: 'Popcorn, air-popped', m: 'Snacks, popcorn, air-popped' },
  { c: 'Snacks & sweets', n: 'Ice cream, vanilla', m: 'Ice creams, vanilla' },
  { c: 'Snacks & sweets', n: 'Chocolate chip cookie', m: 'Cookies, chocolate chip, commercially prepared, regular, higher fat, enriched' },
  { c: 'Snacks & sweets', n: 'Graham crackers', m: 'Cookies, graham crackers, plain or honey' },
  { c: 'Snacks & sweets', n: 'Saltine crackers', m: 'Crackers, saltines' },

  /* ------------------------------------------- bakery, donuts, breakfast */
  // The generic version of what a bakery, a gas station or a
  // coffee shop sells, so one donut is one search and not a chain.
  { c: 'Bakery & donuts', n: 'Donut, glazed', m: 'Doughnuts, yeast-leavened, glazed, enriched' },
  { c: 'Bakery & donuts', n: 'Donut, cake, plain', m: 'Doughnuts, cake-type, plain (includes unsugared' },
  { c: 'Bakery & donuts', n: 'Donut, cake, sugared or glazed', m: 'Doughnuts, cake-type, plain, sugared or glazed' },
  { c: 'Bakery & donuts', n: 'Donut, chocolate frosted', m: 'Doughnuts, cake-type, plain, chocolate-coated or frosted' },
  { c: 'Bakery & donuts', n: 'Donut, chocolate cake, glazed', m: 'Doughnuts, cake-type, chocolate, sugared or glazed' },
  { c: 'Bakery & donuts', n: 'Donut, jelly-filled', m: 'Doughnuts, yeast-leavened, with jelly filling' },
  { c: 'Bakery & donuts', n: 'Donut, cream-filled', m: 'Doughnuts, yeast-leavened, with creme filling' },
  { c: 'Bakery & donuts', n: 'Cruller, glazed', m: 'Doughnuts, french crullers, glazed' },
  { c: 'Bakery & donuts', n: 'Muffin, blueberry', m: 'Muffins, blueberry, commercially prepared' },
  { c: 'Bakery & donuts', n: 'Muffin, corn', m: 'Muffins, corn, commercially prepared' },
  { c: 'Bakery & donuts', n: 'Croissant', m: 'Croissants, butter' },
  { c: 'Bakery & donuts', n: 'Danish, cheese', m: 'Danish pastry, cheese' },
  { c: 'Bakery & donuts', n: 'Danish, fruit', m: 'Danish pastry, fruit, enriched' },
  { c: 'Bakery & donuts', n: 'Cinnamon roll, frosted', m: 'Sweet rolls, cinnamon, refrigerated dough with frosting, baked' },
  { c: 'Bakery & donuts', n: 'Cinnamon roll, bakery', m: 'Sweet rolls, cinnamon, commercially prepared with raisins' },
  { c: 'Bakery & donuts', n: 'Coffee cake', m: 'Cake, coffeecake, cinnamon with crumb topping, commercially prepared' },
  { c: 'Bakery & donuts', n: 'Toaster pastry (Pop-Tart style)', m: 'Toaster Pastries, fruit, frosted' },
  { c: 'Bakery & donuts', n: 'Bagel, cinnamon raisin', m: 'Bagels, cinnamon-raisin', avoid: ['toasted'] },
  { c: 'Bakery & donuts', n: 'Biscuit', m: 'Biscuits, plain or buttermilk, frozen, baked' },
  { c: 'Bakery & donuts', n: 'Waffle, frozen', m: 'Waffles, plain, frozen, ready-to-heat', avoid: ['toasted'] },
  { c: 'Bakery & donuts', n: 'French toast', m: 'French toast, frozen, ready-to-heat' },

  /* ---------------------------------------------------------- desserts */
  { c: 'Desserts', n: 'Brownie', m: 'Cookies, brownies, commercially prepared' },
  { c: 'Desserts', n: 'Cookie, oatmeal', m: 'Cookies, oatmeal, commercially prepared, regular' },
  { c: 'Desserts', n: 'Cookie, peanut butter', m: 'Cookies, peanut butter, commercially prepared, regular' },
  { c: 'Desserts', n: 'Cookie, sugar', m: 'Cookies, sugar, refrigerated dough, baked' },
  { c: 'Desserts', n: 'Sandwich cookie (Oreo style)', m: 'Cookies, chocolate sandwich, with creme filling, regular', avoid: ['coated'] },
  { c: 'Desserts', n: 'Cheesecake', m: 'Cake, cheesecake, commercially prepared' },
  { c: 'Desserts', n: 'Chocolate cake, frosted', m: 'Cake, chocolate, commercially prepared with chocolate frosting' },
  { c: 'Desserts', n: 'Yellow cake, vanilla frosting', m: 'Cake, yellow, commercially prepared, with vanilla frosting' },
  { c: 'Desserts', n: 'Pound cake', m: 'Cake, pound, commercially prepared, butter' },
  { c: 'Desserts', n: 'Snack cake, chocolate creme-filled', m: 'Cake, snack cakes, creme-filled, chocolate with frosting', avoid: ['low-fat'] },
  { c: 'Desserts', n: 'Snack cake, sponge creme-filled', m: 'Cake, snack cakes, creme-filled, sponge' },
  { c: 'Desserts', n: 'Apple pie', m: 'Pie, apple, commercially prepared, enriched flour' },
  { c: 'Desserts', n: 'Pumpkin pie', m: 'Pie, pumpkin, commercially prepared' },
  { c: 'Desserts', n: 'Pecan pie', m: 'Pie, pecan, commercially prepared' },
  { c: 'Desserts', n: 'Cherry pie', m: 'Pie, cherry, commercially prepared' },
  { c: 'Desserts', n: 'Ice cream, chocolate', m: 'Ice creams, chocolate', avoid: ['light', 'rich', 'low carbohydrate'] },
  { c: 'Desserts', n: 'Ice cream, strawberry', m: 'Ice creams, strawberry' },
  { c: 'Desserts', n: 'Soft serve', m: 'Ice creams, french vanilla, soft-serve' },
  { c: 'Desserts', n: 'Frozen yogurt', m: 'Frozen yogurts, flavors other than chocolate' },
  { c: 'Desserts', n: 'Milkshake, chocolate', m: 'Milk shakes, thick chocolate' },
  { c: 'Desserts', n: 'Milkshake, vanilla', m: 'Milk shakes, thick vanilla' },
  { c: 'Desserts', n: 'Sundae, hot fudge', m: 'Fast foods, sundae, hot fudge' },
  { c: 'Desserts', n: 'Chocolate pudding', m: 'Puddings, chocolate, ready-to-eat', avoid: ['fat free'] },
  { c: 'Desserts', n: 'Rice Krispies Treat', m: "Snacks, KELLOGG, KELLOGG'S RICE KRISPIES TREATS" },

  /* ------------------------------------------------------------- candy */
  { c: 'Candy', n: 'Snickers', m: 'Candies, MARS SNACKFOOD US, SNICKERS Bar' },
  { c: 'Candy', n: "Reese's Peanut Butter Cups", m: "Candies, REESE'S Peanut Butter Cups" },
  { c: 'Candy', n: "M&M's, milk chocolate", m: "Candies, MARS SNACKFOOD US, M&M's Milk Chocolate Candies" },
  { c: 'Candy', n: "M&M's, peanut", m: "Candies, MARS SNACKFOOD US, M&M's Peanut Chocolate Candies" },
  { c: 'Candy', n: 'Kit Kat', m: 'Candies, KIT KAT Wafer Bar' },
  { c: 'Candy', n: 'Twix', m: 'Candies, MARS SNACKFOOD US, TWIX Caramel Cookie Bars' },
  { c: 'Candy', n: 'Milky Way', m: 'Candies, MARS SNACKFOOD US, MILKY WAY Bar' },
  { c: 'Candy', n: '3 Musketeers', m: 'Candies, MARS SNACKFOOD US, 3 MUSKETEERS Bar' },
  { c: 'Candy', n: 'Butterfinger', m: 'Candies, NESTLE, BUTTERFINGER Bar' },
  { c: 'Candy', n: 'Skittles', m: 'Candies, MARS SNACKFOOD US, SKITTLES Original Bite Size Candies' },
  { c: 'Candy', n: 'Starburst', m: 'Candies, MARS SNACKFOOD US, STARBURST Fruit Chews, Original fruits' },
  { c: 'Candy', n: 'Jelly beans', m: 'Candies, jellybeans' },
  { c: 'Candy', n: 'Gummy candy', m: 'Candies, gumdrops, starch jelly pieces' },
  { c: 'Candy', n: 'Fruit snacks', m: 'Candies, fruit snacks, with high vitamin C' },
  { c: 'Candy', n: 'Marshmallows', m: 'Candies, marshmallows' },
  { c: 'Candy', n: 'Hard candy', m: 'Candies, hard', avoid: ['dietetic', 'sugar free'] },

  /* --------------------------------------------- fast food and takeout */
  // Generic versions, for the burger at a place with no menu in the app.
  { c: 'Fast food & takeout', n: 'Cheeseburger', m: 'Fast foods, cheeseburger; single, regular patty, with condiments' },
  { c: 'Fast food & takeout', n: 'Double cheeseburger', m: 'Fast foods, cheeseburger, double, regular patty and bun, with condiments' },
  { c: 'Fast food & takeout', n: 'Hamburger', m: 'Fast foods, hamburger; single, regular patty; with condiments' },
  { c: 'Fast food & takeout', n: 'French fries', m: 'Fast foods, potato, french fried in vegetable oil' },
  { c: 'Fast food & takeout', n: 'Onion rings', m: 'Fast foods, onion rings, breaded and fried' },
  { c: 'Fast food & takeout', n: 'Chicken nuggets', m: 'Fast foods, chicken, breaded and fried, boneless pieces, plain' },
  { c: 'Fast food & takeout', n: 'Chicken tenders', m: 'Chicken tenders, breaded, frozen, prepared' },
  { c: 'Fast food & takeout', n: 'Fried chicken, breast', m: 'Fast Foods, Fried Chicken, Breast, meat and skin and breading' },
  { c: 'Fast food & takeout', n: 'Fried chicken, drumstick', m: 'Fast Foods, Fried Chicken, Drumstick, meat and skin with breading' },
  { c: 'Fast food & takeout', n: 'Fried chicken, thigh', m: 'Fast Foods, Fried Chicken, Thigh, meat and skin and breading' },
  { c: 'Fast food & takeout', n: 'Fried chicken, wing', m: 'Fast Foods, Fried Chicken, Wing, meat and skin and breading' },
  { c: 'Fast food & takeout', n: 'Crispy chicken sandwich', m: 'Fast Foods, crispy chicken filet sandwich, with lettuce and mayonnaise' },
  { c: 'Fast food & takeout', n: 'Grilled chicken sandwich', m: 'Fast Foods, grilled chicken filet sandwich' },
  { c: 'Fast food & takeout', n: 'Fish sandwich', m: 'Fast foods, fish sandwich, with tartar sauce' },
  { c: 'Fast food & takeout', n: 'Sub, turkey', m: 'Fast foods, submarine sandwich, turkey breast on white bread' },
  { c: 'Fast food & takeout', n: 'Sub, Italian cold cut', m: 'Fast foods, submarine sandwich, cold cut on white bread' },
  { c: 'Fast food & takeout', n: 'Sub, meatball', m: 'Fast foods, submarine sandwich, meatball marinara' },
  { c: 'Fast food & takeout', n: 'Sub, steak and cheese', m: 'Fast foods, submarine sandwich, steak and cheese' },
  { c: 'Fast food & takeout', n: 'Taco, hard shell', m: 'Fast foods, taco with beef, cheese and lettuce, hard shell' },
  { c: 'Fast food & takeout', n: 'Taco, soft', m: 'Fast foods, taco with beef, cheese and lettuce, soft' },
  { c: 'Fast food & takeout', n: 'Burrito, bean and cheese', m: 'Fast foods, burrito, with beans and cheese' },
  { c: 'Fast food & takeout', n: 'Quesadilla, chicken', m: 'Fast foods, quesadilla, with chicken' },
  { c: 'Fast food & takeout', n: 'Nachos with cheese', m: 'Fast foods, nachos, with cheese' },
  { c: 'Fast food & takeout', n: 'Breakfast burrito', m: 'Fast foods, breakfast burrito' },
  { c: 'Fast food & takeout', n: 'Sausage egg biscuit', m: 'Fast Foods, biscuit, with egg and sausage' },
  { c: 'Fast food & takeout', n: 'Egg, cheese & bacon croissant', m: 'Fast foods, croissant, with egg, cheese, and bacon' },
  { c: 'Fast food & takeout', n: 'Egg & cheese English muffin', m: 'Fast foods, english muffin, with egg, cheese, and canadian bacon' },
  { c: 'Fast food & takeout', n: 'Hash browns', m: 'Potatoes, hash brown, frozen, plain, prepared, pan fried' },
  { c: 'Fast food & takeout', n: 'French toast sticks', m: 'Fast foods, french toast sticks' },
  { c: 'Fast food & takeout', n: 'Pizza, cheese', m: 'Pizza, cheese topping, regular crust, frozen, cooked' },
  { c: 'Fast food & takeout', n: 'Pizza, pepperoni', m: 'Pizza, pepperoni topping, regular crust, frozen, cooked' },
  { c: 'Fast food & takeout', n: 'Hot dog (frank only)', m: 'Frankfurter, beef, heated' },
  { c: 'Fast food & takeout', n: 'Egg roll', m: 'Egg rolls, pork, refrigerated, heated' },
  { c: 'Fast food & takeout', n: 'Chili with beans', m: 'Chili con carne with beans, canned entree' },
  { c: 'Fast food & takeout', n: 'Lasagna', m: 'Lasagna with meat sauce, frozen, prepared' },
  { c: 'Fast food & takeout', n: 'Mac and cheese, boxed', m: 'Macaroni and cheese, box mix with cheese sauce, prepared' },
  { c: 'Fast food & takeout', n: 'Coleslaw', m: 'Fast foods, coleslaw' },
  { c: 'Fast food & takeout', n: 'Mashed potatoes', m: 'Fast foods, potato, mashed' },
  { c: 'Fast food & takeout', n: 'Soft pretzel', m: 'Pretzels, soft' },
  { c: 'Fast food & takeout', n: 'Chicken noodle soup', m: 'Soup, chicken noodle, canned, prepared with equal volume water' },
  { c: 'Fast food & takeout', n: 'Tomato soup', m: 'Soup, tomato, canned, prepared with equal volume water, commercial' },
  { c: 'Fast food & takeout', n: 'Ramen, instant', m: 'Soup, ramen noodle, any flavor, dry' },

  /* ------------------------------------------------- more everyday things */
  { c: 'Grains & bread', n: 'Hamburger or hot dog bun', m: 'Rolls, hamburger or hotdog, plain' },
  { c: 'Grains & bread', n: 'Dinner roll', m: 'Rolls, dinner, plain, commercially prepared' },
  { c: 'Grains & bread', n: 'Bread, French or sourdough', m: 'Bread, french or vienna' },
  { c: 'Grains & bread', n: 'Bread, rye', m: 'Bread, rye', avoid: ['toasted'] },
  { c: 'Grains & bread', n: 'Naan', m: 'Bread, naan, plain, commercially prepared' },
  { c: 'Grains & bread', n: 'Egg noodles, cooked', m: 'Noodles, egg, enriched, cooked' },
  { c: 'Meat & fish', n: 'Bacon, pre-sliced, pan-fried', m: 'Pork, cured, bacon, pre-sliced, cooked, pan-fried' },
  { c: 'Meat & fish', n: 'Breakfast sausage', m: 'Pork sausage, link/patty, fully cooked, microwaved' },
  { c: 'Meat & fish', n: 'Salami', m: 'Salami, dry or hard, pork' },
  { c: 'Eggs & dairy', n: 'Chocolate milk', m: 'Milk, chocolate, fluid, commercial, whole' },
  { c: 'Eggs & dairy', n: 'Sour cream', m: 'Cream, sour, cultured' },
  { c: 'Eggs & dairy', n: 'Whipped cream', m: 'Cream, whipped, cream topping, pressurized' },
  { c: 'Eggs & dairy', n: 'Provolone cheese', m: 'Cheese, provolone', avoid: ['reduced'] },
  { c: 'Snacks & sweets', n: 'Granola bar', m: 'Snacks, granola bars, soft, uncoated, chocolate chip', avoid: ['graham'] },
  { c: 'Snacks & sweets', n: 'Trail mix', m: 'Snacks, trail mix, regular', avoid: ['chocolate'] },
  { c: 'Snacks & sweets', n: 'Beef jerky', m: 'Snacks, beef jerky, chopped and formed' },
  { c: 'Snacks & sweets', n: 'Cheese puffs', m: 'Snacks, corn-based, extruded, puffs or twists, cheese-flavor' },
  { c: 'Snacks & sweets', n: 'Nacho cheese tortilla chips', m: 'Snacks, tortilla chips, nacho cheese' },
  { c: 'Snacks & sweets', n: 'Popcorn, microwave', m: 'Snacks, popcorn, oil-popped, microwave, regular flavor' },
  { c: 'Snacks & sweets', n: 'Cheese sandwich crackers', m: 'Crackers, cheese, sandwich-type with cheese filling' },
  { c: 'Condiments', n: 'Jam or jelly', m: 'Jams and preserves' },
  { c: 'Condiments', n: 'Nutella (hazelnut spread)', m: 'Chocolate-flavored hazelnut spread' },
  { c: 'Condiments', n: 'Pancake syrup', m: 'Syrups, table blends, pancake' },
  { c: 'Condiments', n: 'Chocolate syrup', m: 'Syrups, chocolate, fudge-type' },
  { c: 'Condiments', n: 'Caesar dressing', m: 'Salad dressing, caesar dressing, regular' },
  { c: 'Condiments', n: 'Italian dressing', m: 'Salad dressing, italian dressing, commercial, regular' },
  { c: 'Condiments', n: 'Honey mustard dressing', m: 'Salad dressing, honey mustard, regular' },
  { c: 'Condiments', n: 'Tartar sauce', m: 'Sauce, tartar, ready-to-serve' },
  { c: 'Condiments', n: 'Teriyaki sauce', m: 'Sauce, teriyaki, ready-to-serve' },
  { c: 'Condiments', n: 'Pickles, dill', m: 'Pickles, cucumber, dill or kosher dill' },
  { c: 'Drinks', n: 'Cola', m: 'Beverages, carbonated, cola, regular' },
  { c: 'Drinks', n: 'Lemon-lime soda', m: 'Beverages, carbonated, lemon-lime soda, no caffeine' },
  { c: 'Drinks', n: 'Root beer', m: 'Beverages, carbonated, root beer' },
  { c: 'Drinks', n: 'Ginger ale', m: 'Beverages, carbonated, ginger ale' },
  { c: 'Drinks', n: 'Dr Pepper style soda', m: 'Beverages, carbonated, pepper-type, contains caffeine' },
  { c: 'Drinks', n: 'Gatorade', m: 'Beverages, PEPSICO QUAKER, Gatorade, G performance O 2, ready-to-drink' },
  { c: 'Drinks', n: 'Powerade', m: 'Beverages, COCA-COLA, POWERADE, lemon-lime flavored, ready-to-drink' },
  { c: 'Drinks', n: 'Energy drink (Red Bull)', m: 'Beverages, Energy drink, RED BULL', avoid: ['sugar free'] },
  { c: 'Drinks', n: 'Energy drink (Monster)', m: 'Beverages, Energy Drink, Monster' },
  { c: 'Drinks', n: 'Lemonade', m: 'Lemonade, frozen concentrate, white, prepared with water' },
  { c: 'Drinks', n: 'Apple juice', m: 'Apple juice, canned or bottled, unsweetened' },
  { c: 'Drinks', n: 'Cranberry juice cocktail', m: 'Beverages, Cranberry juice cocktail' },
  { c: 'Drinks', n: 'Sweet tea, bottled', m: 'Beverages, tea, black, ready-to-drink, lemon, sweetened' },
  { c: 'Drinks', n: 'Iced coffee, bottled', m: 'Beverages, coffee, ready to drink, milk based, sweetened' },
  { c: 'Drinks', n: 'Hot chocolate', m: 'Milk, chocolate beverage, hot cocoa, homemade' },
  { c: 'Drinks', n: 'Protein powder, whey', m: 'Beverages, Protein powder whey based' },
]

/* -------------------------------------------------------------------- build */

function loadFoods(zipPath) {
  // A zip with one stored/deflated JSON member. Node ships zlib but no unzip, and
  // the archive has exactly one file, so the central directory is read by hand
  // rather than taking a dependency for a single entry.
  const buf = fs.readFileSync(zipPath)
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd === -1) throw new Error('not a zip')
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const method = buf.readUInt16LE(cdOffset + 10)
  const compSize = buf.readUInt32LE(cdOffset + 20)
  const localOffset = buf.readUInt32LE(cdOffset + 42)
  const nameLen = buf.readUInt16LE(localOffset + 26)
  const extraLen = buf.readUInt16LE(localOffset + 28)
  const start = localOffset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + compSize)
  const json = method === 0 ? raw : zlib.inflateRawSync(raw)
  const doc = JSON.parse(json.toString('utf8'))
  return doc[Object.keys(doc)[0]]
}

function macrosOf(food) {
  const out = {}
  for (const n of food.foodNutrients || []) {
    const key = NUTRIENTS[Number(n.nutrient?.number)]
    if (!key || out[key] != null) continue
    const v = Number(n.amount)
    if (Number.isFinite(v)) out[key] = v
  }
  return out
}

const round = (n, dp) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null)

function scale(per100, grams) {
  const k = grams / 100
  return {
    kcal: round((per100.kcal || 0) * k, 0),
    protein: round((per100.protein || 0) * k, 1),
    carbs: round((per100.carbs || 0) * k, 1),
    fat: round((per100.fat || 0) * k, 1),
    fiber: per100.fiber == null ? null : round(per100.fiber * k, 1),
    sugar: per100.sugar == null ? null : round(per100.sugar * k, 1),
    sodium: per100.sodium == null ? null : round(per100.sodium * k, 0),
  }
}

function portionsFor(food, per100) {
  const seen = new Set()
  const picked = (food.foodPortions || [])
    .filter(p => Number(p.gramWeight) > 0)
    .map(p => ({ ...p, rank: rankOf(p.modifier), label: portionLabel(p.amount, p.modifier) }))
    .filter(p => p.rank !== 999)
    // A whole cake, a whole pie, a family bag: real USDA measures, and never
    // what one person means by "a slice". 1,500 kcal keeps a king-size bar.
    .filter(p => (per100.kcal || 0) * p.gramWeight / 100 <= 1500)
    /*
     * Ordered by how much it looks like ONE SERVING, not by unit. Ranking units
     * alphabetically or by a fixed list led every fat and nut with "1 cup" — a
     * cup of butter is 1,628 kcal and nobody has ever eaten one, while a cup of
     * rice is exactly what a portion of rice is. Calorie proximity to a typical
     * serving sorts both correctly with one rule, and the unit rank survives only
     * as a tiebreak between portions of similar size.
     */
    .map(p => ({
      ...p,
      kcal: (per100.kcal || 0) * p.gramWeight / 100,
      // "Large" is the egg you buy; "extra large" and "jumbo" are the ones you
      // notice. Nudged down so the default size is the ordinary one.
      odd: /\b(extra|jumbo|giant|mini|baby)\b/i.test(p.modifier || '') ? 1 : 0,
    }))
    .sort((a, b) =>
      (Math.abs(a.kcal - SERVING_KCAL) + a.rank * 6 + a.odd * 40)
      - (Math.abs(b.kcal - SERVING_KCAL) + b.rank * 6 + b.odd * 40))
    .filter(p => {
      const k = p.label.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, 4)
    .map((p, i) => ({
      id: `p${i}`,
      label: p.label,
      grams: round(p.gramWeight, 1),
      ...scale(per100, p.gramWeight),
    }))

  // 100 g last and always, so anything on a scale is still loggable.
  picked.push({ id: '100g', label: '100 g', grams: 100, ...scale(per100, 100) })
  return picked
}

const zipPath = process.argv.includes('--zip')
  ? process.argv[process.argv.indexOf('--zip') + 1]
  : '/tmp/fdc_sr.zip'

if (!fs.existsSync(zipPath)) {
  console.error(`missing ${zipPath}\n  curl -sL -o ${zipPath} "${SOURCE_URL}"`)
  process.exit(1)
}

const foods = loadFoods(zipPath)
const byDesc = foods.map(f => ({ f, d: String(f.description || '') }))

const out = []
const missed = []

for (const item of CATALOG) {
  const want = item.m.toLowerCase()
  const candidates = byDesc
    .filter(({ d }) => d.toLowerCase().startsWith(want))
    .filter(({ d }) => !(item.avoid || []).some(a => d.toLowerCase().includes(a.toLowerCase())))
    // Shortest description wins: USDA qualifies the unusual variants at length,
    // so the plainest name is nearly always the everyday food.
    .sort((a, b) => a.d.length - b.d.length)

  if (!candidates.length) { missed.push(item); continue }

  const food = candidates[0].f
  const per100 = macrosOf(food)
  if (!Number.isFinite(per100.kcal)) { missed.push({ ...item, why: 'no energy' }); continue }

  out.push({
    id: item.n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: item.n,
    category: item.c,
    source: 'usda',
    // The receipt. Every number above came from this record and can be checked.
    fdcId: food.fdcId,
    usdaName: food.description,
    portions: portionsFor(food, per100),
  })
}

const categories = [...new Set(CATALOG.map(i => i.c))]
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify({
  generatedAt: new Date().toISOString().slice(0, 10),
  source: { name: 'USDA FoodData Central — SR Legacy', url: SOURCE_URL },
  note: 'Generated by scripts/basics.build.mjs. Do not hand-edit; edit the CATALOG there and re-run.',
  categories,
  foods: out,
}, null, 2)}\n`)

console.log(`wrote ${out.length}/${CATALOG.length} foods to content/basics.json`)
if (missed.length) {
  console.log(`\n${missed.length} did not match — fix the matcher in CATALOG:`)
  for (const m of missed) console.log(`  ${m.n.padEnd(32)} ${m.why || 'no description starts with'} "${m.m}"`)
}
