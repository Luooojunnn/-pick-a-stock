import { serve } from "bun";
import index from "./index.html";
import { route as stockBasicRoute } from "./apis/stock-basic";
import { route as dailyRecommendationsRoute } from "./apis/get-the-daily-recommendations";
import { route as howToSellRoute } from "./apis/how-to-sell";

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    // 批量注入 Tushare 相关接口
    ...stockBasicRoute,
    ...dailyRecommendationsRoute,
    ...howToSellRoute,

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/hello/:name": async req => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
