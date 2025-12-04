const request = require("supertest");
const express = require("express");
const { createUserRouter } = require("../routes/userRoutes");

const buildApp = (overrides = {}) => {
  const userCollection = overrides.userCollection || {
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: "abc123" }),
  };
  const tutorCollection = overrides.tutorCollection || {
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: "tutor123" }),
  };
  const generateCustomId =
    overrides.generateCustomId || jest.fn().mockResolvedValue("SID-1");

  const app = express();
  app.use(express.json());
  app.use(
    createUserRouter({
      userCollection,
      tutorCollection,
      generateCustomId,
    })
  );

  return { app, userCollection, tutorCollection, generateCustomId };
};

describe("userRoutes", () => {
  test("returns early when user already exists", async () => {
    const { app, userCollection } = buildApp({
      userCollection: {
        findOne: jest.fn().mockResolvedValue({ email: "exists@example.com" }),
        insertOne: jest.fn(),
      },
    });

    const res = await request(app)
      .post("/users")
      .send({ email: "exists@example.com", phone: "012" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: "user already exists",
      insertedId: null,
    });
    expect(userCollection.findOne).toHaveBeenCalled();
  });

  test("creates a new user with generated custom id", async () => {
    const { app, generateCustomId, userCollection } = buildApp();

    const res = await request(app)
      .post("/users")
      .send({ email: "new@example.com", phone: "123", role: "student" });

    expect(res.status).toBe(200);
    expect(generateCustomId).toHaveBeenCalledWith("student", userCollection);
    expect(res.body.customId).toBe("SID-1");
    expect(userCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "new@example.com",
        customId: "SID-1",
      })
    );
  });

  test("rejects tutor creation when role is not tutor", async () => {
    const { app, tutorCollection } = buildApp();

    const res = await request(app)
      .post("/tutors")
      .send({ email: "bad@tutor.com", role: "student" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only tutors/i);
    expect(tutorCollection.insertOne).not.toHaveBeenCalled();
  });
});

