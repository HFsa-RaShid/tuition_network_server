const express = require("express");

function createUserRouter({ userCollection, tutorCollection, generateCustomId }) {
  if (!userCollection || !generateCustomId) {
    throw new Error("userCollection and generateCustomId are required");
  }

  const router = express.Router();

  router.post("/users", async (req, res) => {
    const user = req.body;

    const query = {
      $or: [{ email: user.email }, { phone: user.phone }],
    };
    const existingUser = await userCollection.findOne(query);
    if (existingUser) {
      return res.send({ message: "user already exists", insertedId: null });
    }

    const customId = await generateCustomId(user.role, userCollection);

    const newUser = {
      ...user,
      customId,
      createdAt: new Date(),
    };

    const result = await userCollection.insertOne(newUser);
    res.send({ ...result, customId });
  });

  router.post("/tutors", async (req, res) => {
    if (!tutorCollection) {
      return res
        .status(500)
        .send({ message: "Tutor collection is not configured" });
    }

    const tutor = req.body;

    if (tutor.role !== "tutor") {
      return res
        .status(400)
        .send({ message: "Only tutors can be added to tutors collection" });
    }

    const query = { email: tutor.email };
    const existingTutor = await tutorCollection.findOne(query);
    if (existingTutor) {
      return res.send({ message: "Tutor already exists", insertedId: null });
    }

    tutor.role = "tutor";

    const customId = await generateCustomId("tutor", tutorCollection);

    const newTutor = {
      ...tutor,
      customId,
      createdAt: new Date(),
    };

    const result = await tutorCollection.insertOne(newTutor);
    res.send({ ...result, customId });
  });

  return router;
}

module.exports = { createUserRouter };

