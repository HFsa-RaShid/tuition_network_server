const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sanitizeString = (value) => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return value.toString().trim();
  }
  return "";
};

const normalizeEmail = (value) => {
  const email = sanitizeString(value).toLowerCase();
  return emailRegex.test(email) ? email : "";
};

const coerceNumber = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numericPortion = value.replace(/[^0-9.]/g, "");
    if (!numericPortion) {
      return null;
    }
    const parsed = Number(numericPortion);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const toPositiveNumber = (value) => {
  const num = coerceNumber(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num;
};

const normalizeSubjects = (subjects) => {
  if (!subjects) {
    return [];
  }

  if (Array.isArray(subjects)) {
    return subjects.map(sanitizeString).filter(Boolean);
  }

  if (typeof subjects === "string") {
    return subjects.split(",").map(sanitizeString).filter(Boolean);
  }

  return [];
};

const validateTutorRequestPayload = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      isValid: false,
      errors: ["Each tutor request must be an object"],
      sanitized: null,
    };
  }

  const errors = [];
  const sanitized = { ...payload };

  sanitized.studentEmail = normalizeEmail(
    payload.studentEmail || payload.email
  );
  if (!sanitized.studentEmail) {
    errors.push("studentEmail is required and must be valid");
  }

  sanitized.studentName = sanitizeString(payload.studentName || payload.name);
  if (!sanitized.studentName) {
    errors.push("studentName is required");
  }

  sanitized.phone = sanitizeString(
    payload.phone ||
      payload.contactNumber ||
      payload.guardianPhone ||
      payload.mobile
  );
  if (!sanitized.phone) {
    errors.push("phone is required");
  }

  sanitized.city = sanitizeString(payload.city);
  if (!sanitized.city) {
    errors.push("city is required");
  }

  sanitized.location = sanitizeString(payload.location);
  if (!sanitized.location) {
    errors.push("location is required");
  }

  sanitized.classCourse = sanitizeString(
    payload.classCourse || payload.classLevel
  );
  if (!sanitized.classCourse) {
    errors.push("classCourse is required");
  }

  const subjects = normalizeSubjects(payload.subjects || payload.subject);
  if (!subjects.length) {
    errors.push("subjects must include at least one value");
  } else {
    sanitized.subjects = subjects;
  }

  const salary = toPositiveNumber(payload.salary);
  if (salary === null) {
    errors.push("salary must be a positive number");
  } else {
    sanitized.salary = salary;
  }

  const daysPerWeek = toPositiveNumber(payload.daysPerWeek);
  if (daysPerWeek !== null) {
    sanitized.daysPerWeek = daysPerWeek;
  }

  const weeklyDuration = toPositiveNumber(payload.weeklyDuration);
  if (weeklyDuration !== null) {
    sanitized.weeklyDuration = weeklyDuration;
  }

  sanitized.description = sanitizeString(payload.description);

  delete sanitized.tuitionId;
  delete sanitized.createdAt;
  delete sanitized.appliedTutors;

  return {
    isValid: errors.length === 0,
    errors,
    sanitized,
  };
};

module.exports = {
  emailRegex,
  sanitizeString,
  normalizeEmail,
  coerceNumber,
  toPositiveNumber,
  normalizeSubjects,
  validateTutorRequestPayload,
};

