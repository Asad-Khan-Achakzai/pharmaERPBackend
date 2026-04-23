const roundPKR = (value) => Math.round(value * 100) / 100;

const formatPKR = (value) => `PKR ${roundPKR(value).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = { roundPKR, formatPKR };
