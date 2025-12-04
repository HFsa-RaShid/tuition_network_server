const express = require("express");
const {
  validateTutorRequestPayload,
} = require("../utils/tutorRequestValidation");

function createTutorRequestRouter({
  tutorRequestCollection,
  generateTuitionId,
}) {
  if (!tutorRequestCollection || !generateTuitionId) {
    throw new Error(
      "tutorRequestCollection and generateTuitionId are required"
    );
  }

  const router = express.Router();

  router.post("/tutorRequests", async (req, res) => {
    try {
      const payload = req.body;

      if (Array.isArray(payload)) {
        if (payload.length === 0) {
          return res.status(400).send({
            message: "Payload array must contain at least one request",
          });
        }

        const validationResults = payload.map((item, index) => ({
          index,
          ...validateTutorRequestPayload(item),
        }));

        const validItems = validationResults
          .filter((entry) => entry.isValid)
          .map((entry) => entry.sanitized);

        if (validItems.length === 0) {
          return res.status(422).send({
            message: "All tutor requests failed validation",
            errors: validationResults.map(({ index, errors }) => ({
              index,
              errors,
            })),
          });
        }

        const lastRequest = await tutorRequestCollection.findOne(
          {},
          { sort: { createdAt: -1 } }
        );
        const lastNumber = lastRequest?.tuitionId
          ? parseInt(lastRequest.tuitionId, 10) || 0
          : 0;
        const tuitionIds = Array.from(
          { length: validItems.length },
          (_, idx) => `${lastNumber + idx + 1}`
        );

        const docsToInsert = validItems.map((item, idx) => ({
          ...item,
          tuitionId: tuitionIds[idx],
          createdAt: new Date(),
        }));

        const insertResult = await tutorRequestCollection.insertMany(
          docsToInsert
        );

        const rejected = validationResults
          .filter((entry) => !entry.isValid)
          .map(({ index, errors }) => ({ index, errors }));

        return res.status(rejected.length ? 207 : 201).send({
          message: rejected.length
            ? "Tutor requests processed with some validation failures"
            : "Tutor requests submitted successfully",
          insertedCount: insertResult.insertedCount,
          insertedIds: Object.values(insertResult.insertedIds).map((id) =>
            id.toString()
          ),
          rejected,
        });
      }

      const { isValid, errors, sanitized } =
        validateTutorRequestPayload(payload);

      if (!isValid) {
        return res.status(422).send({
          message: "Validation failed",
          errors,
        });
      }

      const tuitionId = await generateTuitionId(tutorRequestCollection);

      const result = await tutorRequestCollection.insertOne({
        ...sanitized,
        tuitionId,
        createdAt: new Date(),
      });

      res.status(201).send({
        message: "Tutor request submitted successfully",
        insertedId: result.insertedId,
        tuitionId,
      });
    } catch (error) {
      console.error("Error submitting tutor request:", error);
      res.status(500).send({ message: "Error submitting tutor request" });
    }
  });

  return router;
}

module.exports = { createTutorRequestRouter };

