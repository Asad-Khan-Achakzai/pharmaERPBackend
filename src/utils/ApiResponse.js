class ApiResponse {
  constructor(statusCode, data, message = 'Success') {
    this.success = statusCode < 400;
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
  }

  static success(res, data, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json(new ApiResponse(statusCode, data, message));
  }

  static created(res, data, message = 'Created successfully') {
    return res.status(201).json(new ApiResponse(201, data, message));
  }

  static paginated(res, { docs, total, page, limit }, message = 'Success') {
    return res.status(200).json({
      success: true,
      statusCode: 200,
      message,
      data: docs,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  }

  /** Same as paginated, plus a shallow `meta` object for callers that need extra context (e.g. running-balance opening). */
  static paginatedWithMeta(res, { docs, total, page, limit, meta = {} }, message = 'Success') {
    const lim = limit || 10;
    return res.status(200).json({
      success: true,
      statusCode: 200,
      message,
      data: docs,
      pagination: {
        total,
        page,
        limit: lim,
        pages: Math.max(1, Math.ceil(total / lim))
      },
      meta
    });
  }
}

module.exports = ApiResponse;
