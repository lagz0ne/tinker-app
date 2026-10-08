import { createFileRoute } from "@tanstack/react-router";
import { runGreet } from "../transport/greet.functions";

export const Route = createFileRoute("/")({
  loader: () => runGreet(),
  component: () => <p>{Route.useLoaderData().text}</p>,
});
