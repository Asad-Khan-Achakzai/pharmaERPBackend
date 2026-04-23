const ApiError = require('../utils/ApiError');

const validate = (schema) => (req, _res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    const messages = error.details.map((d) => d.message).join(', ');
    return next(new ApiError(400, messages));
  }

  req.body = value;
  next();
};

const validateQuery = (schema) => (req, _res, next) => {
  const { error, value } = schema.validate(req.query, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    const messages = error.details.map((d) => d.message).join(', ');
    return next(new ApiError(400, messages));
  }

  req.query = value;
  next();
};

module.exports = { validate, validateQuery };
