import { describe, expect, it } from "vitest";
import { isNonSpend, parseAmount, parseDate, parseStatement, StatementParseError } from "../statement";


describe("parseDate / parseAmount", () => {
  it("parses US date shapes to ISO", () => {
    expect(parseDate("09/03/2026")).toBe("2026-09-03");
    expect(parseDate("9/3/26")).toBe("2026-09-03");
    expect(parseDate("2026-09-03")).toBe("2026-09-03");
    expect(parseDate("Sep 3, 2026")).toBe("2026-09-03");
    expect(parseDate("Sept 3 2026")).toBe("2026-09-03");
    expect(parseDate("3 Sep 2026")).toBe("2026-09-03");
    expect(parseDate("02/30/2026")).toBeNull();
    expect(parseDate("Date")).toBeNull();
  });
  it("parses money shapes", () => {
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount("-12.30")).toBe(-12.3);
    expect(parseAmount("(12.30)")).toBe(-12.3);
    expect(parseAmount("12.30 CR")).toBe(-12.3);
    expect(parseAmount("-$5")).toBe(-5);
    expect(parseAmount("$-5")).toBe(-5);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
});

describe("parseStatement", () => {
  it("reads Chase credit card (purchases negative) and drops payments", () => {
    const p = parseStatement(
      [
        "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
        "09/02/2026,09/03/2026,SQ *BLUE BOTTLE COFFEE,Food & Drink,Sale,-6.80,",
        "09/05/2026,09/06/2026,LILIA,Food & Drink,Sale,-112.40,",
        "09/07/2026,09/07/2026,Payment Thank You-Mobile,,Payment,500.00,",
        "09/09/2026,09/10/2026,LILIA,Food & Drink,Return,12.40,",
      ].join("\n"),
    );
    expect(p.format).toBe("chase_card");
    expect(p.transactions.map((t) => [t.rawMerchant, t.amount])).toEqual([
      ["SQ *BLUE BOTTLE COFFEE", 6.8],
      ["LILIA", 112.4],
      ["LILIA", -12.4],
    ]);
    expect(p.skipped.nonSpend).toBe(1);
    expect(p.bankCategories.t0).toBe("Food & Drink");
    expect(p.range).toEqual({ from: "2026-09-02", to: "2026-09-09" });
    expect(p.windowDays).toBe(8);
  });

  it("reads Amex (purchases positive)", () => {
    const p = parseStatement(
      [
        "Date,Description,Card Member,Account #,Amount",
        "09/01/2026,WHOLEFDS WBG 10234 BROOKLYN NY,M RIVERA,-41008,45.90",
        "09/04/2026,AUTOPAY PAYMENT - THANK YOU,M RIVERA,-41008,-800.00",
      ].join("\n"),
    );
    expect(p.format).toBe("amex");
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0].amount).toBe(45.9);
  });

  it("reads Capital One and Citi debit/credit columns", () => {
    const c1 = parseStatement(
      [
        "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit",
        "2026-09-01,2026-09-02,1234,SOULCYCLE WILLIAMSBURG,Health Care,34.00,",
        "2026-09-03,2026-09-04,1234,SOULCYCLE WILLIAMSBURG,Health Care,,34.00",
      ].join("\n"),
    );
    expect(c1.format).toBe("capital_one");
    expect(c1.transactions.map((t) => t.amount)).toEqual([34, -34]);
    const citi = parseStatement(
      ["Status,Date,Description,Debit,Credit", "Cleared,09/12/2026,TICKETMASTER,186.00,"].join("\n"),
    );
    expect(citi.format).toBe("citi");
    expect(citi.transactions[0].amount).toBe(186);
  });

  it("reads Apple Card using the clean Merchant column", () => {
    const p = parseStatement(
      [
        "Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By",
        "09/08/2026,09/09/2026,VARIETY COFFEE ROASTERS 368 GRAHAM AVE BROOKLYN 11211 NY USA,Variety Coffee,Restaurants,Purchase,4.50,Maya",
        "09/10/2026,09/10/2026,ACH DEPOSIT INTERNET TRANSFER,Apple Card,Payment,Payment,-200.00,Maya",
      ].join("\n"),
    );
    expect(p.format).toBe("apple_card");
    expect(p.transactions.map((t) => [t.rawMerchant, t.amount])).toEqual([["Variety Coffee", 4.5]]);
  });

  it("reads Discover, Bank of America card and checking (with preamble)", () => {
    expect(
      parseStatement(["Trans. Date,Post Date,Description,Amount,Category", "09/01/2026,09/02/2026,TRADER JOE'S #558,35.10,Supermarkets"].join("\n"))
        .format,
    ).toBe("discover");
    const boa = parseStatement(
      ["Posted Date,Reference Number,Payee,Address,Amount", "09/03/2026,2469216,LEO WILLIAMSBURG,BROOKLYN NY,-48.00"].join("\n"),
    );
    expect([boa.format, boa.transactions[0].amount]).toEqual(["boa_card", 48]);
    const chk = parseStatement(
      [
        "Description,,Summary Amt.",
        "Beginning balance as of 09/01/2026,,\"2,000.00\"",
        "",
        "Date,Description,Amount,Running Bal.",
        "09/01/2026,Beginning balance as of 09/01/2026,,\"2,000.00\"",
        "09/04/2026,NITEHAWK CINEMA BROOKLYN,-32.00,\"1,968.00\"",
        "09/05/2026,Zelle payment to JANE DOE,-50.00,\"1,918.00\"",
      ].join("\n"),
    );
    expect(chk.format).toBe("boa_checking");
    expect(chk.transactions.map((t) => [t.rawMerchant, t.amount])).toEqual([["NITEHAWK CINEMA BROOKLYN", 32]]);
    expect(chk.skipped).toEqual({ nonSpend: 1, invalid: 1 });
  });

  it("reads headerless Wells Fargo", () => {
    const p = parseStatement(
      ['"09/02/2026","-6.80","*","","PURCHASE AUTHORIZED ON 09/01 BLUE BOTTLE COFFEE BROOKLYN NY S386"', '"09/03/2026","2500.00","*","","PAYROLL ACME"'].join(
        "\n",
      ),
    );
    expect(p.format).toBe("wells_fargo");
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0].amount).toBe(6.8);
  });

  it("reads generic persona CSVs and infers the spend sign", () => {
    const pos = parseStatement("date,merchant,amount,category\n2026-09-01,Lilia,112.40,restaurant\n2026-09-02,Lilia,-10,restaurant\n2026-09-03,Blue Bottle Coffee,6.80,coffee");
    expect(pos.format).toBe("generic");
    expect(pos.transactions.map((t) => t.amount)).toEqual([112.4, -10, 6.8]);
    const neg = parseStatement("Date;Payee;Amount\nnot a date;Cafe;-4.50\n2026-09-02;Cafe;-4.50\n2026-09-03;Cafe;-5.00");
    expect(neg.transactions.map((t) => t.amount)).toEqual([4.5, 5]);
    expect(neg.skipped.invalid).toBe(1);
  });

  it("throws typed errors for unusable files", () => {
    const code = (t: string) => {
      try {
        parseStatement(t);
      } catch (e) {
        return (e as StatementParseError).code;
      }
    };
    expect(code("")).toBe("empty");
    expect(code("foo,bar\n1,2")).toBe("no_header");
    expect(code("date,merchant,amount\n2026-09-01,Payment Thank You,50")).toBe("no_rows");
  });

  it("flags non-spend rows by type or descriptor", () => {
    expect(isNonSpend("Zelle payment to JANE DOE")).toBe(true);
    expect(isNonSpend("ONLINE TRANSFER TO SAV")).toBe(true);
    expect(isNonSpend("Blue Bottle", "Payment")).toBe(true);
    expect(isNonSpend("Blue Bottle", "Sale")).toBe(false);
    expect(isNonSpend("BAR GOTO")).toBe(false);
  });
});
