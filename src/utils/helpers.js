const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const pickFields = (obj, fields) => {
  const picked = {};
  for (const field of fields) {
    if (obj[field] !== undefined) {
      picked[field] = obj[field];
    }
  }
  return picked;
};

module.exports = { isValidObjectId, pickFields };
