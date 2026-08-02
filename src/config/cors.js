const env = require('./env');

const corsOptions = {
  // Allow FE to read download filenames from blob responses
  exposedHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length'],
  origin(origin, callback) {
    if (!origin || env.FRONTEND_ORIGINS.includes(origin.replace(/\/$/, ''))) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

module.exports = corsOptions;
