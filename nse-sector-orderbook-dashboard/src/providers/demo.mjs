const q = function (symbol, price, change, cashBid, cashAsk, futureBid, futureAsk, contract) {
  return {
    symbol: symbol,
    price: price,
    close: price / (1 + change / 100),
    percentChange: change,
    cash: { bidQty: cashBid, askQty: cashAsk, netQty: cashBid - cashAsk, levels: 5 },
    futures: { bidQty: futureBid, askQty: futureAsk, netQty: futureBid - futureAsk, levels: 5 },
    futureContract: contract,
    futureExpiry: "nearest listed expiry",
    sourceTime: new Date().toISOString()
  };
};

export const demoIndices = [
  { name: "Nifty Auto", value: 26134.55, percentChange: 0.42 },
  { name: "Nifty Bank", value: 59482.10, percentChange: -0.34 },
  { name: "Nifty Chemicals", value: 40782.85, percentChange: 0.21 },
  { name: "Nifty FMCG", value: 58124.40, percentChange: 0.06 },
  { name: "Nifty IT", value: 38420.25, percentChange: -0.55 },
  { name: "Nifty Metal", value: 10314.90, percentChange: 1.12 },
  { name: "Nifty Pharma", value: 23450.75, percentChange: -0.12 },
  { name: "Nifty Realty", value: 976.35, percentChange: 0.81 }
];

export const demoQuotes = [
  q("ABB", 5842.00, -0.73, 4800, 7100, 1500, 2400, "ABB-FUT"),
  q("HDFCBANK", 1742.65, 0.28, 67200, 58500, 18600, 17400, "HDFCBANK-FUT"),
  q("ICICIBANK", 1284.35, -0.09, 22700, 24500, 8600, 6500, "ICICIBANK-FUT"),
  q("INFY", 1558.90, 0.16, 15800, 12400, 5500, 6100, "INFY-FUT"),
  q("RELIANCE", 2014.20, 0.62, 128400, 101200, 34500, 29100, "RELIANCE-FUT"),
  q("TATASTEEL", 164.85, -0.41, 28100, 34700, 6200, 7800, "TATASTEEL-FUT")
];

