import mongoose from "mongoose";

// Connect to MongoDB using Mongoose.
export const connectDb = async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    throw new Error("DATABASE_URL is required");
  }

  await mongoose.connect(uri);
};

// Close the MongoDB connection.
export const disconnectDb = async () => {
  await mongoose.disconnect();
};
