const {
  validateTutorRequestPayload,
  normalizeEmail,
  sanitizeString,
} = require("../utils/tutorRequestValidation");

describe("tutorRequestValidation", () => {
  test("rejects invalid payloads", () => {
    const result = validateTutorRequestPayload({});
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("studentEmail is required and must be valid");
  });

  test("sanitizes and validates a full payload", () => {
    const payload = {
      studentEmail: "   STUDENT@example.com ",
      studentName: "  Alice ",
      phone: " 01234 ",
      city: "Dhaka",
      location: "Uttara",
      classCourse: "Class 5",
      subjects: "Math, Science",
      salary: "5000",
      daysPerWeek: "5",
      weeklyDuration: "10",
      description: " Need a tutor ",
    };

    const result = validateTutorRequestPayload(payload);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.sanitized.studentEmail).toBe("student@example.com");
    expect(result.sanitized.subjects).toEqual(["Math", "Science"]);
    expect(result.sanitized.salary).toBe(5000);
  });

  test("helpers trim strings and normalize emails", () => {
    expect(sanitizeString("  hello ")).toBe("hello");
    expect(normalizeEmail("  USER@Example.com ")).toBe("user@example.com");
    expect(normalizeEmail("bad-email")).toBe("");
  });
});

