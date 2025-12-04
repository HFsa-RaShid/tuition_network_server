const request = require("supertest");
const express = require("express");
const { createTutorRequestRouter } = require("../routes/tutorRequestRoutes");

const buildApp = (overrides = {}) => {
  const tutorRequestCollection = overrides.tutorRequestCollection || {
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: "req123" }),
    insertMany: jest.fn().mockResolvedValue({
      insertedCount: 1,
      insertedIds: { 0: "abc" },
    }),
  };
  const generateTuitionId =
    overrides.generateTuitionId || jest.fn().mockResolvedValue("42");

  const app = express();
  app.use(express.json());
  app.use(
    createTutorRequestRouter({
      tutorRequestCollection,
      generateTuitionId,
    })
  );

  return { app, tutorRequestCollection, generateTuitionId };
};

const basePayload = {
  studentEmail: "student@example.com",
  studentName: "Student",
  phone: "0123",
  city: "Dhaka",
  location: "Uttara",
  classCourse: "Class 5",
  subjects: ["Math"],
  salary: 5000,
};

describe("tutorRequestRoutes", () => {
  test("creates a single tutor request", async () => {
    const { app, tutorRequestCollection, generateTuitionId } = buildApp();

    const res = await request(app).post("/tutorRequests").send(basePayload);

    expect(res.status).toBe(201);
    expect(generateTuitionId).toHaveBeenCalled();
    expect(tutorRequestCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        studentEmail: "student@example.com",
        tuitionId: "42",
      })
    );
  });

  test("rejects invalid payload", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/tutorRequests")
      .send({ studentEmail: "bad" });

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
  });

  test("handles bulk payload with mixed validity", async () => {
    const { app, tutorRequestCollection } = buildApp({
      tutorRequestCollection: {
        findOne: jest.fn().mockResolvedValue({ tuitionId: "10" }),
        insertMany: jest.fn().mockResolvedValue({
          insertedCount: 1,
          insertedIds: { 0: "aaa" },
        }),
      },
    });

    const res = await request(app)
      .post("/tutorRequests")
      .send([basePayload, { studentEmail: "" }]);

    expect(res.status).toBe(207);
    expect(tutorRequestCollection.insertMany).toHaveBeenCalled();
    expect(res.body.rejected).toHaveLength(1);
  });
});

