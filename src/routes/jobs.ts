import { FastifyInstance } from "fastify";
import { runAutoPlanCronOnce } from "../services/autoPlanService";

export default async function jobsRoutes(fastify: FastifyInstance) {
  // Secured endpoint for external schedulers.
  fastify.post("/jobs/auto-plan/run", async (request, reply) => {
    const secret = process.env.JOB_SECRET;
    const header = request.headers["x-job-secret"];
    const headerValue = Array.isArray(header) ? header[0] : header;

    if (!secret || headerValue !== secret) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    await runAutoPlanCronOnce();
    return { ok: true };
  });
}
