/**
 * Fixed NYC benchmark set: 40 public businesses with synthetic
 * card-statement descriptors. Names are public; nothing here comes from a
 * Qloo response. Edit only with a version bump (BENCHMARK_SET_VERSION).
 */
import type { Category } from "../lib/contract";

export const BENCHMARK_SET_VERSION = 1;
export const BENCHMARK_CITY = "New York, NY";

export interface BenchmarkMerchant {
  id: string;
  /** Synthetic statement descriptor, as a bank would print it. */
  descriptor: string;
  /** Ground-truth public name (for scoring resolution, never sent to Qloo). */
  name: string;
  category: Category;
  hood: string;
}

const m = (id: string, descriptor: string, name: string, category: Category, hood: string): BenchmarkMerchant => ({
  id,
  descriptor,
  name,
  category,
  hood,
});

export const BENCHMARK_MERCHANTS: BenchmarkMerchant[] = [
  // coffee
  m("b01", "SQ *BLUE BOTTLE COFFE", "Blue Bottle Coffee", "coffee", "Chelsea"),
  m("b02", "LA COLOMBE SOHO NY", "La Colombe Coffee Roasters", "coffee", "SoHo"),
  m("b03", "RALPHS COFFEE NEW YORK", "Ralph's Coffee", "coffee", "SoHo"),
  m("b04", "DEVOCION WILLIAMSBURG", "Devoción", "coffee", "Williamsburg"),
  m("b05", "BLUESTONE LANE #12 NY", "Bluestone Lane", "coffee", "Financial District"),
  m("b06", "STARBUCKS STORE 22871", "Starbucks", "coffee", "Midtown"),
  m("b07", "SQ *PARTNERS COFFEE", "Partners Coffee", "coffee", "Williamsburg"),
  // restaurants
  m("b08", "CARBONE NEW YORK", "Carbone", "restaurant", "West Village"),
  m("b09", "BALTHAZAR RESTAURANT", "Balthazar", "restaurant", "SoHo"),
  m("b10", "TST* LILIA", "Lilia", "restaurant", "Williamsburg"),
  m("b11", "VIA CAROTA NEW YORK NY", "Via Carota", "restaurant", "West Village"),
  m("b12", "LE COUCOU NEW YORK", "Le Coucou", "restaurant", "SoHo"),
  m("b13", "RAOULS RESTAURANT NY", "Raoul's", "restaurant", "SoHo"),
  m("b14", "PETER LUGER STEAK HOUSE", "Peter Luger Steak House", "restaurant", "Williamsburg"),
  m("b15", "LE BERNARDIN NEW YORK", "Le Bernardin", "restaurant", "Midtown"),
  m("b16", "TST* LLAMA INN", "Llama Inn", "restaurant", "Williamsburg"),
  m("b17", "COTE NEW YORK NY", "Cote Korean Steakhouse", "restaurant", "Flatiron"),
  m("b18", "ATOBOY NEW YORK", "Atoboy", "restaurant", "Flatiron"),
  m("b19", "MOMOFUKU NOODLE BAR", "Momofuku Noodle Bar", "restaurant", "East Village"),
  m("b20", "KATZS DELICATESSEN", "Katz's Delicatessen", "restaurant", "Lower East Side"),
  m("b21", "TST* DIMES", "Dimes", "restaurant", "Lower East Side"),
  m("b22", "CAFE MOGADOR NY", "Cafe Mogador", "restaurant", "East Village"),
  m("b23", "TST* THAI DINER", "Thai Diner", "restaurant", "SoHo"),
  m("b24", "LUCALI BROOKLYN", "Lucali", "restaurant", "Park Slope"),
  m("b25", "VESELKA NEW YORK", "Veselka", "restaurant", "East Village"),
  // fast casual
  m("b26", "SWEETGREEN FLATIRON", "Sweetgreen", "fast_food", "Flatiron"),
  m("b27", "CAVA CHELSEA 0231", "CAVA", "fast_food", "Chelsea"),
  m("b28", "SHAKE SHACK MADISON SQ", "Shake Shack", "fast_food", "Flatiron"),
  m("b29", "DIG INN FLATIRON", "Dig", "fast_food", "Flatiron"),
  m("b30", "SUPERIORITY BURGER", "Superiority Burger", "fast_food", "East Village"),
  // bars
  m("b31", "DEATH & CO NEW YORK", "Death & Co", "bar", "East Village"),
  m("b32", "EMPLOYEES ONLY NYC", "Employees Only", "bar", "West Village"),
  m("b33", "ATTABOY NEW YORK NY", "Attaboy", "bar", "Lower East Side"),
  m("b34", "PDT CRIF DOGS", "Please Don't Tell", "bar", "East Village"),
  m("b35", "THE FOUR HORSEMEN BKLYN", "The Four Horsemen", "bar", "Williamsburg"),
  // fitness, grocery, beauty
  m("b36", "EQUINOX #118 NEW YORK", "Equinox", "fitness", "Flatiron"),
  m("b37", "SOULCYCLE CHELSEA", "SoulCycle", "fitness", "Chelsea"),
  m("b38", "BARRYS BOOTCAMP CHELSEA", "Barry's", "fitness", "Chelsea"),
  m("b39", "WHOLEFDS CHE 10180", "Whole Foods Market", "grocery", "Chelsea"),
  m("b40", "DRYBAR FLATIRON NY", "Drybar", "beauty", "Flatiron"),
];

/** Fixed monthly visit profile per category for the savings basket. */
export const VISITS_PER_MONTH: Partial<Record<Category, number>> = {
  coffee: 12,
  restaurant: 2,
  fast_food: 6,
  bar: 3,
  fitness: 1,
  grocery: 4,
  beauty: 1,
};
