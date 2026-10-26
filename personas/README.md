# Personas

Three synthetic New York personas for demos, tests and the eval. All
transactions are invented (September 2026); merchant names are public
businesses, descriptors imitate card statements ("SQ *BLUE BTL 0423").
No real person's data.

CSV columns: `date,description,amount,currency`; a positive amount is spend.
`index.ts` has the persona metadata (location for the agent request), a CSV
parser and the merchant aggregation the agent expects.
