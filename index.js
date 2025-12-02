const express = require("express");
require("dotenv").config();
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const SSLCommerzPayment = require("sslcommerz-lts");
const jwt = require("jsonwebtoken");
const app = express();
const { ObjectId } = require("mongodb");

const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.aq8mwv9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    // strict: false,
    deprecationErrors: true,
  },
});

const store_id = process.env.STORE_ID;
const store_passwd = process.env.STORE_PASSWD;
const is_live = false; //true for live, false for sandbox

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    const userCollection = client.db("tuitionNetworkDB").collection("users");
    const tutorRequestCollection = client
      .db("tuitionNetworkDB")
      .collection("tutorRequests");
    const tutorRequestDemoCollection = client
      .db("tuitionNetworkDB")
      .collection("tutorRequestsDemo");
    const paymentCollection = client
      .db("tuitionNetworkDB")
      .collection("payments");
    const tutorCollection = client.db("tuitionNetworkDB").collection("tutors");

    const tempVerificationCollection = client
      .db("tuitionNetworkDB")
      .collection("tempVerifications");
    const noticeCollection = client
      .db("tuitionNetworkDB")
      .collection("dashboardNotices");

    const ReviewsCollection = client
      .db("tuitionNetworkDB")
      .collection("reviews");

    // ------------------ Custom ID Generator ------------------
    async function generateCustomId(role, collection) {
      const prefix = role === "student" ? "SID" : "TID";

      const lastUser = await collection
        .find({ role })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();

      let newNumber = 1;
      if (lastUser.length > 0 && lastUser[0].customId) {
        const lastId = lastUser[0].customId; //  SID-5
        const lastNumber = parseInt(lastId.split("-")[1]);
        newNumber = lastNumber + 1;
      }

      return `${prefix}-${newNumber}`;
    }

    // ------------------ Tuition ID Generator ------------------
    async function generateTuitionId(collection) {
      const lastRequest = await collection.findOne(
        {},
        { sort: { createdAt: -1 } }
      );

      const lastNumber = lastRequest?.tuitionId
        ? parseInt(lastRequest.tuitionId, 10) || 0
        : 0;

      return `${lastNumber + 1}`;
    }

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

    function validateTutorRequestPayload(payload) {
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

      sanitized.studentName = sanitizeString(
        payload.studentName || payload.name
      );
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
    }

    //............................................

    // auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      // console.log('user for token', user);
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
    });

    const verifyToken = (req, res, next) => {
      // console.log('inside verifyToken', req.headers.authorization);
      // next();
      if (!req.headers.authorization) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = req.headers.authorization.split(" ")[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: "unauthorized access" });
        }
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isAdmin = user?.role === "admin";
      if (!isAdmin) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.get("/users",verifyToken,verifyAdmin, async (req, res) => {
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    app.put("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const updatedData = req.body;

      const result = await userCollection.updateOne(
        { email },
        { $set: updatedData },
        { upsert: false }
      );

      res.send(result);
    });

    // GET /users/:email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        let user = await userCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ error: "User not found" });
        }

        // Auto-check subscription expiry
        if (user.profileStatus === "Premium") {
          const lastPayment = await paymentCollection.findOne(
            { email, source: "getPremium", paidStatus: true },
            { sort: { paymentTime: -1 } }
          );

          if (lastPayment) {
            const now = new Date();
            const paymentDate = new Date(lastPayment.paymentTime);
            const diffInDays = (now - paymentDate) / (1000 * 60 * 60 * 24);

            if (diffInDays >= 30) {
              // Downgrade to free
              await userCollection.updateOne(
                { email },
                { $set: { profileStatus: "Free" } }
              );
              user.profileStatus = "Free";
            }
          }
        }

        res.send(user);
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    app.post("/users", async (req, res) => {
      const user = req.body;

      const query = {
        $or: [{ email: user.email }, { phone: user.phone }],
      };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }

      // Custom ID generate
      const customId = await generateCustomId(user.role, userCollection);

      const newUser = {
        ...user,
        customId,

        createdAt: new Date(),
      };

      const result = await userCollection.insertOne(newUser);
      res.send({ ...result, customId });
    });

    app.post("/tutors", async (req, res) => {
      const tutor = req.body;

      // Only allow tutor role to be added to tutors collection
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

      // Custom ID generate
      const customId = await generateCustomId("tutor", tutorCollection);

      const newTutor = {
        ...tutor,
        customId,

        createdAt: new Date(),
      };

      const result = await tutorCollection.insertOne(newTutor);
      res.send({ ...result, customId });
    });

    //.....................//

    app.post("/send-verification", async (req, res) => {
      const { email, phone } = req.body;

      if (!email || !phone) {
        return res.status(400).send({ message: "Email & Phone are required" });
      }

      try {
        // Check if email or phone already exists in main users collection
        const existingUser = await userCollection.findOne({
          $or: [{ email }, { phone }],
        });

        if (existingUser) {
          if (existingUser.email === email) {
            return res.status(400).send({ message: "Email already used" });
          }
          if (existingUser.phone === phone) {
            return res
              .status(400)
              .send({ message: "Phone number already used" });
          }
        }

        // Generate 6-digit code
        const verificationCode = Math.floor(
          100000 + Math.random() * 900000
        ).toString();
        const expiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        // Save or update verification code
        await tempVerificationCollection.updateOne(
          { email },
          { $set: { verificationCode, verificationExpires: expiry } },
          { upsert: true }
        );

        // Send Email
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        const mailOptions = {
          from: `"TuToria" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "Your TuToria Email Verification Code",
          html: `
        <div style="font-family:Arial;padding:20px;background:#f7f9fc;">
          <h2>Your Verification Code</h2>
          <h1 style="color:#2563eb;font-size:32px;">${verificationCode}</h1>
        </div>
      `,
        };

        await transporter.sendMail(mailOptions);

        res.send({ message: "Verification code sent successfully!" });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to send verification code" });
      }
    });

    //..............................

    app.post("/verify-code", async (req, res) => {
      const { email, code } = req.body;

      try {
        const record = await tempVerificationCollection.findOne({ email });
        if (!record)
          return res
            .status(404)
            .send({ message: "No verification request found" });

        const now = new Date();
        if (now > new Date(record.verificationExpires)) {
          return res.status(400).send({ message: "Verification code expired" });
        }

        if (record.verificationCode !== code) {
          return res.status(400).send({ message: "Invalid verification code" });
        }

        await tempVerificationCollection.deleteOne({ email });

        res.send({ message: "Email verified successfully!" });
      } catch (error) {
        console.error("Error verifying code:", error);
        res.status(500).send({ message: "Server error during verification" });
      }
    });
    //....................//

    app.get("/find-email-by-phone/:phone", async (req, res) => {
      const phone = req.params.phone;

      const user = await userCollection.findOne({ phone });

      if (!user) {
        return res.status(404).send({ message: "Phone number not found" });
      }

      res.send({ email: user.email });
    });

    //...............//

    app.put("/tutors/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const updatedData = req.body;

      if (updatedData.rating) {
        const tutor = await tutorCollection.findOne({ email });

        let ratings = tutor?.ratings || [];
        ratings.push(updatedData.rating);

        // average calculation
        const averageRating =
          ratings.reduce((sum, r) => sum + r, 0) / ratings.length;

        updatedData.ratings = ratings;
        updatedData.averageRating = averageRating;
      }

      const result = await tutorCollection.updateOne(
        { email },
        { $set: updatedData },
        { upsert: true }
      );

      res.send(result);
    });

    // get all tutors

    app.get("/tutors", async (req, res) => {
      const tutors = await tutorCollection.find().toArray();
      res.send(tutors);
    });

    // get tutor by email

    app.get("/tutors/:email", async (req, res) => {
      const email = req.params.email;
      const tutor = await tutorCollection.findOne({ email: email });
      res.send(tutor);
    });

    // get tutor profile by id

    app.get("/tutors/profile/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const tutor = await tutorCollection.findOne({ customId: id });
        if (!tutor) {
          return res.status(404).send({ message: "Tutor not found" });
        }
        res.send(tutor);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // delete user by admin
    app.delete("/users/:email", verifyToken, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.deleteOne({ email });
      res.send(result);
    });

    // get users by search
    app.get("/searchUsers", async (req, res) => {
      const searchTerm = req.query.q.toLowerCase();
      const users = await userCollection
        .find({
          role: { $ne: "admin" },
          $or: [
            { name: { $regex: searchTerm, $options: "i" } },
            { email: { $regex: searchTerm, $options: "i" } },
            { customId: { $regex: searchTerm, $options: "i" } },
          ],
        })
        .toArray();
      res.send(users);
    });

    // Post tutor request (single or bulk)

    app.post("/tutorRequests", async (req, res) => {
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

          // Generate tuition IDs for bulk insert
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

    // get all tutor requests
    app.get("/tutorRequests", async (req, res) => {
      const result = await tutorRequestCollection.find().toArray();
      res.send(result);
    });

    // Get all confirmed tutors for a specific tutor email
    app.get("/confirmedTutors/:email", async (req, res) => {
      const userEmail = req.params.email.toLowerCase();

      try {
        // Find all tutor requests where this tutor applied and got confirmed
        const posts = await tutorRequestCollection
          .find({ "appliedTutors.email": tutorEmail })
          .toArray();

        // Filter only confirmed tutors
        const confirmedTutors = posts
          .map((post) =>
            post.appliedTutors
              .filter(
                (tutor) =>
                  tutor.email.toLowerCase() === tutorEmail &&
                  tutor.confirmationStatus === "confirmed"
              )
              .map((tutor) => ({
                name: tutor.name,
                email: tutor.email,
                photoURL:
                  tutor.photoURL ||
                  "https://i.ibb.co/7n4R8Rt/default-avatar.png",
                postId: post._id,
                location: post.location,
                salary: post.salary,
                duration: post.duration,
              }))
          )
          .flat();

        res.status(200).json(confirmedTutors);
      } catch (error) {
        console.error("Error fetching confirmed tutors:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // approve and apply jobs ,update tutor requests
    app.put("/tutorRequests/:id", async (req, res) => {
      const { id } = req.params;
      const { email, name, tutorId, status, tutorStatus } = req.body;

      try {
        let result;

        if (tutorStatus) {
          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { tutorStatus } }
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Tutor status updated successfully." });
          } else {
            return res
              .status(404)
              .send({ message: "Request not found or not modified." });
          }
        }

        // Applying for a tutor request

        if (email) {
          const applyObject = {
            email,
            name,
            tutorId,
            appliedAt: new Date(),
          };

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id), "appliedTutors.email": { $ne: email } },
            { $push: { appliedTutors: applyObject } }
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Applied successfully." });
          } else {
            return res
              .status(400)
              .send({ message: "Already applied or request not found." });
          }
        }

        // Updating tutor request status by admin
        if (status !== undefined) {
          let updateQuery;

          if (status === "") {
            updateQuery = { $unset: { status: "" } };
          } else {
            updateQuery = { $set: { status } };
          }

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            updateQuery
          );

          if (result.modifiedCount > 0) {
            if (status === "approved") {
              const request = await tutorRequestCollection.findOne({
                _id: new ObjectId(id),
              });

              // find premium tutors in the same city and preferredLocations includes request location
              const premiumTutors = await tutorCollection
                .find({
                  role: "tutor",
                  profileStatus: "Premium",
                  city: request.city,
                })
                .toArray();

              const tutorsToEmail = premiumTutors.filter((tutor) =>
                tutor.preferredLocations
                  ?.split(",")
                  .map((loc) => loc.trim().toLowerCase())
                  .includes(request.location?.trim().toLowerCase())
              );

              if (tutorsToEmail.length > 0) {
                const transporter = nodemailer.createTransport({
                  service: "gmail",
                  auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS,
                  },
                });

                for (const tutor of tutorsToEmail) {
                  const mailOptions = {
                    from: `"TuToria" <${process.env.EMAIL_USER}>`,
                    to: tutor.email,
                    subject: "New Approved Tuition in Your Area!",
                    html: `<div style="max-width:600px;margin:auto;font-family:Arial,Helvetica,sans-serif;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1)">
                          <div style="background:#4f46e5;color:#fff;padding:15px 20px;font-size:20px;font-weight:bold;text-align:center">
                            🎉 New Tuition Opportunity!
                          </div>
                          <div style="padding:20px;background:#fafafa">
                            <h2 style="color:#333;margin:0 0 10px">📚 ${
                              request.classCourse
                            } Tuition</h2>
                            <p><strong>City:</strong> ${request.city}</p>
                            <p><strong>Location:</strong> ${
                              request.location
                            }</p>
                            <p><strong>Subjects:</strong> ${request.subjects?.join(
                              ", "
                            )}</p>
                            <p><strong>Salary:</strong> ${
                              request.salary
                            } Tk/Month</p>
                            <p><strong>Duration:</strong> ${
                              request.duration || "Not Specified"
                            }</p>
                          </div>
                          <div style="padding:20px;text-align:center;background:#fff">
                            <a href="https://tutoria-jet.vercel.app/tuitions"
                              style="display:inline-block;padding:12px 25px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold">
                              👉 Apply Now
                            </a>
                            <p style="margin-top:15px;font-size:13px;color:#888">
                              This is an automated email. Please do not reply.
                            </p>
                          </div>
                        </div>`,
                  };

                  try {
                    const info = await transporter.sendMail(mailOptions);
                    console.log("Email sent:", info.response);
                  } catch (err) {
                    console.error("Email send error:", err);
                  }
                }
              } else {
                console.log("No premium tutors found for this location.");
              }
            }

            return res.send({ message: "Status updated successfully." });
          } else {
            return res

              .status(404)
              .send({ message: "Request not found or not modified." });
          }
        }

        // tutorStatus, confirm, cancelConfirmation

        if (tutorStatus !== undefined) {
          let updateQuery;

          if (tutorStatus === "") {
            updateQuery = { $unset: { tutorStatus: "" } };
          } else {
            updateQuery = { $set: { tutorStatus } };
          }

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            updateQuery
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Tutor status updated successfully." });
          } else {
            return res
              .status(404)
              .send({ message: "Request not found or not modified." });
          }
        }

        // Confirming a tutor
        if (req.body.confirmedTutorEmail) {
          const { confirmedTutorEmail } = req.body;

          const tutorRequest = await tutorRequestCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!tutorRequest) {
            return res
              .status(404)
              .send({ message: "Tutor request not found." });
          }

          const updatedTutors = tutorRequest.appliedTutors.map((tutor) => {
            if (tutor.email === confirmedTutorEmail) {
              return { ...tutor, confirmationStatus: "confirmed" };
            } else {
              const { confirmationStatus, ...rest } = tutor;
              return rest;
            }
          });

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { appliedTutors: updatedTutors } }
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Tutor confirmed successfully." });
          } else {
            return res
              .status(400)
              .send({ message: "Failed to confirm tutor." });
          }
        }

        // Canceling a tutor confirmation
        if (req.body.cancelConfirmation) {
          const tutorRequest = await tutorRequestCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!tutorRequest) {
            return res
              .status(404)
              .send({ message: "Tutor request not found." });
          }

          const updatedTutors = tutorRequest.appliedTutors.map(
            ({ confirmationStatus, ...rest }) => rest
          );

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { appliedTutors: updatedTutors } }
          );

          if (result.modifiedCount > 0) {
            return res.send({
              message: "Tutor confirmation cancelled successfully.",
            });
          } else {
            return res
              .status(400)
              .send({ message: "Failed to cancel confirmation." });
          }
        }

        // If no valid fields provided
        return res
          .status(400)
          .send({ message: "Nothing to update. Provide valid fields." });
      } catch (error) {
        console.error("Error in PUT /tutorRequests/:id:", error);
        return res
          .status(500)
          .send({ message: "Server error. Please try again later." });
      }
    });

    // GET tutor info by email
    app.get("/appliedTutors/:email", async (req, res) => {
      const email = req.params.email.toLowerCase();
      try {
        const tutor = await tutorCollection.findOne({ email: email });
        if (!tutor) {
          return res.status(404).send({ message: "Tutor not found" });
        }
        res.send(tutor);
      } catch (error) {
        console.error("Error fetching tutor:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // GET applied tutors for jobId
    app.get("/appliedTutorForJobId/:jobId", async (req, res) => {
      const jobId = req.params.jobId;

      try {
        const job = await tutorRequestCollection.findOne({
          _id: new ObjectId(jobId),
        });
        if (!job) {
          return res.status(404).json({ message: "Job not found" });
        }
        res.json(job.appliedTutors || []);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // delete tutor request by admin
    app.delete("/tutorRequests/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await tutorRequestCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        console.error("Error deleting job:", error);
        res.status(500).send({ error: "Failed to delete job" });
      }
    });

    // get all payments (admin)
    app.get("/paymentBkash", verifyToken, verifyAdmin, async (req, res) => {
      const paymentBkash = await paymentCollection.find().toArray();
      res.send(paymentBkash);
    });

    // Payment Integration with SSLCommerz
    app.post("/paymentBkash", async (req, res) => {
      const {
        jobId,
        name,
        email,
        tutorId,
        amount,
        tutorAmount,
        tuToriaAmount,
        source,
        studentEmail,
        studentName,
        role,
        productName = "Tuition Payment",
      } = req.body;
      const tran_id = new ObjectId().toString();

      const data = {
        total_amount: amount,
        currency: "BDT",
        tran_id,
        success_url: `http://localhost:5000/payment/success/${tran_id}`,
        fail_url: `http://localhost:5000/payment/fail/${tran_id}`,
        cancel_url: `http://localhost:5000/paymentCancel`,
        ipn_url: `http://localhost:5000/ipn`,
        shipping_method: "Courier",
        product_name: productName,
        product_category: "Tuition",
        product_profile: "general",
        cus_name: name,
        cus_email: email,
        cus_add1: "Dhaka",
        cus_add2: "Dhaka",
        cus_city: "Dhaka",
        cus_state: "Dhaka",
        cus_postcode: "1000",
        cus_country: "Bangladesh",
        cus_phone: "01711111111",
        cus_fax: "01711111111",
        ship_name: "Customer Name",
        ship_add1: "Dhaka",
        ship_add2: "Dhaka",
        ship_city: "Dhaka",
        ship_state: "Dhaka",
        ship_postcode: 1000,
        ship_country: "Bangladesh",
      };

      const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
      sslcz.init(data).then((apiResponse) => {
        res.send({ url: apiResponse.GatewayPageURL });

        paymentCollection.insertOne({
          jobId,
          transactionId: tran_id,
          amount,
          tutorAmount,
          tuToriaAmount,
          email,
          tutorId,
          name,
          source,
          studentEmail,
          studentName,
          role,
          paidStatus: false,
          paymentTime: new Date(),
        });
      });
    });

    // SUCCESS Route (Dynamic redirect)
    app.post("/payment/success/:tranId", async (req, res) => {
      const payment = await paymentCollection.findOne({
        transactionId: req.params.tranId,
      });

      if (!payment) {
        return res.status(404).send("Payment not found");
      }

      await paymentCollection.updateOne(
        { transactionId: req.params.tranId },
        { $set: { paidStatus: true } }
      );

      if (payment.source === "myApplications") {
        res.redirect(
          `https://tutoria-jet.vercel.app/tutor/payment/success/${req.params.tranId}`
        );
      } else if (payment.source === "trialClassPayment") {
        res.redirect(
          `https://tutoria-jet.vercel.app/student/payment/success/${req.params.tranId}`
        );
      } else if (payment.source === "advanceSalary") {
        res.redirect(
          `https://tutoria-jet.vercel.app/student/payment/success/${req.params.tranId}`
        );
      } else if (payment.source === "getPremium") {
        // Set premium expiry date (30 days from now)
        const premiumExpiry = new Date();
        premiumExpiry.setDate(premiumExpiry.getDate() + 30);

        // Update user with premium status and expiry date
        await userCollection.updateOne(
          { email: payment.email },
          {
            $set: {
              profileStatus: "Premium",
              premiumExpiry: premiumExpiry,
            },
          }
        );

        // Update tutor if role is tutor
        if (payment.role === "tutor") {
          await tutorCollection.updateOne(
            { email: payment.email },
            {
              $set: {
                profileStatus: "Premium",
                premiumExpiry: premiumExpiry,
              },
            }
          );
        }

        res.redirect(
          `https://tutoria-jet.vercel.app/${payment.role}/payment/success/${req.params.tranId}`
        );
      }
    });

    // FAIL Route (Dynamic redirect)
    app.post("/payment/fail/:tranId", async (req, res) => {
      const payment = await paymentCollection.findOne({
        transactionId: req.params.tranId,
      });

      if (!payment) {
        return res.status(404).send("Payment not found");
      }

      await paymentCollection.deleteOne({ transactionId: req.params.tranId });

      if (payment.source === "myApplications") {
        res.redirect(`https://tutoria-jet.vercel.app/tutor/myApplications`);
      } else if (payment.source === "trialClassPayment") {
        res.redirect(`https://tutoria-jet.vercel.app/student/hired-tutors`);
      } else if (payment.source === "advanceSalary") {
        res.redirect(`https://tutoria-jet.vercel.app/student/hired-tutors`);
      } else if (payment.source === "getPremium") {
        res.redirect(
          `https://tutoria-jet.vercel.app/${payment.role}/get-premium`
        );
      }
    });
    // GET payment by transactionId

    app.get("/payment/success/:tranId", async (req, res) => {
      const tranId = req.params.tranId;

      try {
        const payment = await paymentCollection.findOne({
          transactionId: tranId,
        });

        if (!payment) {
          return res.status(404).json({ message: "Payment not found" });
        }

        res.status(200).json(payment);
      } catch (error) {
        console.error("Error fetching payment:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // GET all payments for a jobId
    app.get("/payments/:jobId", async (req, res) => {
      const { jobId } = req.params;
      try {
        const payments = await paymentCollection
          .find({ jobId, paidStatus: true })
          .toArray();
        res.status(200).json(payments);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch payment data" });
      }
    });

    //paymentHistory-tutor

    app.get("/tutor/paidJobs/:email", async (req, res) => {
      const email = req.params.email;

      const payments = await paymentCollection
        .find({ email, paidStatus: true, source: "myApplications" })
        .toArray();

      const paidJobIds = payments.map((p) => new ObjectId(p.jobId));

      const jobs = await tutorRequestCollection
        .find({ _id: { $in: paidJobIds } })
        .toArray();

      // Merge payment info with job info
      const merged = payments.map((payment) => {
        const job = jobs.find((j) => j._id.toString() === payment.jobId);
        return {
          ...payment,
          jobDetails: job || null,
        };
      });

      res.send(merged);
    });

    //paymentHistory-student + Hired Tutors
    app.get("/student/paidJobs/:studentEmail", async (req, res) => {
      const studentEmail = req.params.studentEmail;

      const payments = await paymentCollection
        .find({ studentEmail, paidStatus: true })
        .toArray();

      const paidJobIds = payments.map((p) => new ObjectId(p.jobId));

      const jobs = await tutorRequestCollection
        .find({ _id: { $in: paidJobIds } })
        .toArray();

      // Merge payment info with job info
      const merged = payments.map((payment) => {
        const job = jobs.find((j) => j._id.toString() === payment.jobId);
        return {
          ...payment,
          jobDetails: job || null,
        };
      });

      res.send(merged);
    });

    // GET multiple payments by jobIds
    app.post("/payments/multiple", async (req, res) => {
      const { jobIds } = req.body;
      if (!Array.isArray(jobIds))
        return res.status(400).send("jobIds must be an array");

      try {
        const payments = await paymentCollection
          .find({
            jobId: { $in: jobIds },
          })
          .toArray();

        res.json(payments);
      } catch (error) {
        res.status(500).send("Server error");
      }
    });

    //........................................................//

    // Nominatim geocode proxy
    app.get("/geocode", async (req, res) => {
      const { q } = req.query; // ?q=location_query
      if (!q)
        return res.status(400).json({ error: "Missing query parameter q" });

      try {
        const response = await axios.get(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
            q
          )}`,
          {
            headers: {
              "Accept-Language": "en",
              "User-Agent": "tuToria (contact: hafsa.cse28gmail.com)",
            },
          }
        );

        res.json(response.data);
      } catch (err) {
        console.error("Geocoding error:", err.message);
        res.status(500).json({ error: "Geocoding failed" });
      }
    });

    // Dashboard notices
    app.get("/notices", async (req, res) => {
      try {
        const notices = await noticeCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.send(notices);
      } catch (error) {
        console.error("Error fetching notices:", error);
        res.status(500).send({ message: "Failed to fetch notices" });
      }
    });
    // Post a new notice

    app.post("/notices", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const {
          title,
          message,
          audience = "all",
          priority = "normal",
        } = req.body || {};

        if (!title || !message) {
          return res
            .status(400)
            .send({ message: "Title and message are required" });
        }

        const doc = {
          title: title.trim(),
          message: message.trim(),
          audience,
          priority,
          createdAt: new Date(),
        };

        const result = await noticeCollection.insertOne(doc);
        res
          .status(201)
          .send({ insertedId: result.insertedId, message: "Notice posted" });
      } catch (error) {
        console.error("Error posting notice:", error);
        res.status(500).send({ message: "Failed to post notice" });
      }
    });
    // Delete a notice

    app.delete("/notices/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await noticeCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Notice not found" });
        }

        res.send({ message: "Notice removed" });
      } catch (error) {
        console.error("Error deleting notice:", error);
        res.status(500).send({ message: "Failed to delete notice" });
      }
    });
    // Admin Stats Summary

    app.get(
      "/admin/stats-summary",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const [
            totalUsers,
            totalTutors,
            totalRequests,
            pendingRequests,
            totalPayments,
          ] = await Promise.all([
            userCollection.countDocuments(),
            tutorCollection.countDocuments(),
            tutorRequestCollection.countDocuments(),
            tutorRequestCollection.countDocuments({ status: "pending" }),
            paymentCollection.countDocuments({ paidStatus: true }),
          ]);

          const recentPayments = await paymentCollection
            .find({ paidStatus: true })
            .sort({ paymentTime: -1 })
            .limit(6)
            .toArray();

          const revenueSummary = recentPayments.reduce(
            (acc, payment) => {
              acc.total += payment.amount || 0;
              acc.tutor += payment.tutorAmount || 0;
              acc.platform += payment.tuToriaAmount || 0;
              return acc;
            },
            { total: 0, tutor: 0, platform: 0 }
          );

          const activeStudents = await paymentCollection
            .aggregate([
              { $match: { paidStatus: true } },
              { $group: { _id: "$studentEmail" } },
            ])
            .toArray();

          const activeTutors = await paymentCollection
            .aggregate([
              {
                $match: {
                  paidStatus: true,
                  source: { $in: ["myApplications", "contactTutor"] },
                },
              },
              { $group: { _id: "$email" } },
            ])
            .toArray();

          res.send({
            totalUsers,
            totalTutors,
            totalRequests,
            pendingRequests,
            totalPayments,
            revenueSummary,
            recentPayments,
            activeStudents: activeStudents.length,
            activeTutors: activeTutors.length,
          });
        } catch (error) {
          console.error("Error computing stats:", error);
          res.status(500).send({ message: "Failed to compute stats" });
        }
      }
    );

    //...............................................
    // POST Demo Request

    app.post("/tutorRequests/demo", verifyToken, async (req, res) => {
      const {
        createdAt,
        studentId,
        studentName,
        studentEmail,
        studentPhone,
        tutorId,
        tutorName,
        tutorEmail,
        tutorPhone,
      } = req.body;

      //Required fields validation
      if (
        !studentId ||
        !studentName ||
        !studentEmail ||
        !tutorId ||
        !tutorName
      ) {
        return res.status(422).json({ message: "Missing required fields" });
      }

      const newRequest = {
        createdAt: createdAt || new Date().toISOString(),
        studentId,
        studentName,
        studentEmail,
        studentPhone: studentPhone || "",
        tutorId,
        tutorName,
        tutorEmail: tutorEmail || "",
        tutorPhone: tutorPhone || "",
        status: "pending",
      };

      try {
        const result = await tutorRequestDemoCollection.insertOne(newRequest);
        res.status(201).json({
          message: "Tutor request sent successfully",
          requestId: result.insertedId,
        });
      } catch (err) {
        console.error("Error inserting tutor request:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    //.......................................//
    // Get all demo tutor requests
    app.get("/tutorRequests/demo", verifyToken,verifyAdmin, async (req, res) => {
      try {
        const requests = await tutorRequestDemoCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({
          message: "Demo requests fetched successfully",
          requests,
        });
      } catch (err) {
        console.error("Error fetching demo requests:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ------------------ SEND LINK ROUTE ------------------
    app.post("/tutorRequests/send-link", async (req, res) => {
      try {
        const { requestId, link, datetime } = req.body;
        if (!requestId || !link || !datetime)
          return res.status(422).json({ message: "Missing required fields" });

        const request = await tutorRequestDemoCollection.findOne({
          _id: new ObjectId(requestId),
        });
        if (!request)
          return res.status(404).json({ message: "Request not found" });

        await tutorRequestDemoCollection.updateOne(
          { _id: new ObjectId(requestId) },
          {
            $set: {
              meetingLink: link,
              meetingDatetime: datetime,
              status: "linkSent",
            },
          }
        );

        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        // Email to student
        await transporter.sendMail({
          from: `"TuToria" <${process.env.EMAIL_USER}>`,
          to: request.studentEmail,
          subject: "Meeting Link Sent - TuToria",
          html: `
        <p>Hi ${request.studentName},</p>
        <p>Your tutor <strong>${request.tutorName}</strong> has sent a meeting link:</p>
        <p><a href="${link}" target="_blank">${link}</a></p>
        <p>Scheduled at: ${datetime}</p>
        <p>Best regards,<br/>TuToria Team</p>
      `,
        });

        // Email to tutor
        if (request.tutorEmail) {
          await transporter.sendMail({
            from: `"TuToria" <${process.env.EMAIL_USER}>`,
            to: request.tutorEmail,
            subject: "Meeting Link Sent - TuToria",
            html: `
          <p>Hi ${request.tutorName},</p>
          <p>You have sent a meeting link to <strong>${request.studentName}</strong>:</p>
          <p><a href="${link}" target="_blank">${link}</a></p>
          <p>Scheduled at: ${datetime}</p>
          <p>Best regards,<br/>TuToria Team</p>
        `,
          });
        }

        res.json({ success: true, message: "Link sent to student and tutor" });
      } catch (error) {
        console.error("Error sending link:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });
    // ------------------ DELETE DEMO REQUEST ------------------

    app.delete("/tutorRequestsDemo/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { notifyMessage } = req.body;

        const request = await tutorRequestDemoCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!request)
          return res.status(404).json({ message: "Request not found" });

        // Setup transporter
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        // Email to Student
        if (notifyMessage) {
          await transporter.sendMail({
            from: `"TuToria" <${process.env.EMAIL_USER}>`,
            to: request.studentEmail,
            subject: "TuToria Request Removed",
            html: `
          <p>Hi ${request.studentName},</p>
          <p>Unfortunately, your tutor <strong>${request.tutorName}</strong> is unable to proceed with this session request.</p>
          <p>Message: ${notifyMessage}</p>
          <p>Best regards,<br/>TuToria Team</p>
        `,
          });
        }

        await tutorRequestDemoCollection.deleteOne({ _id: new ObjectId(id) });

        res.json({
          success: true,
          message: "Request deleted and student notified",
        });
      } catch (err) {
        console.error("Error deleting request:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ------------------ POST REVIEW ------------------
    app.post("/reviews", async (req, res) => {
      try {
        const { name, email, role, rating, review, image } = req.body;

        if (!name || !email || !rating || !review) {
          return res.status(422).json({ message: "Missing fields" });
        }

        const reviewData = {
          name,
          email,
          role,
          rating,
          review,
          image,
          createdAt: new Date(),
        };

        const result = await ReviewsCollection.insertOne(reviewData);

        res.send({
          success: true,
          message: "Review added successfully",
          data: result,
        });
      } catch (err) {
        console.error("Review POST error:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ------------------ GET ALL REVIEWS ------------------
    app.get("/reviews", async (req, res) => {
      try {
        const reviews = await ReviewsCollection.find()
          .sort({ createdAt: -1 })
          .toArray();
        res.send({
          success: true,
          reviews,
        });
      } catch (err) {
        console.error("Review GET error:", err);
        res.status(500).json({ message: "Server error" });
      }
    });
    // DELETE REVIEW (Admin only)
    app.delete("/reviews/:id", verifyToken, async (req, res) => {
      try {
        const reviewId = req.params.id;

        if (!ObjectId.isValid(reviewId))
          return res.status(400).json({ message: "Invalid review ID" });

        const result = await ReviewsCollection.deleteOne({
          _id: new ObjectId(reviewId),
        });

        if (result.deletedCount === 0)
          return res.status(404).json({ message: "Review not found" });

        res.json({ success: true, message: "Review deleted successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });
    //..................Contact with TuToria.....................//
    app.post("/contact", async (req, res) => {
      try {
        const { name, email, message } = req.body;

        if (!name || !email || !message) {
          return res.status(400).json({ message: "All fields are required" });
        }
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });
        await transporter.sendMail({
          from: `"TuToria Contact Form" <${process.env.EMAIL_USER}>`,
          to: process.env.EMAIL_USER,
          subject: "New Contact Message From TuToria Website",
          html: `
        <h3>New Message from TuToria Contact Form</h3>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `,
        });

        res.json({
          success: true,
          message: "Message sent successfully!",
        });
      } catch (error) {
        console.log("Error sending contact email:", error);
        res.status(500).json({ message: "Error sending message" });
      }
    });

    //.......................................//
    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to the server");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
