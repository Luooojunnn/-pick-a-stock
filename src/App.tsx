import { useNavigate, useLocation, Routes, Route } from "react-router-dom";
import { Layout, Menu } from "antd";
import type { MenuProps } from "antd";
import { TodaysRecommendation } from "./pages/TodaysRecommendation";
import { HowToSell } from "./pages/HowToSell";
import { UnderDevelopment } from "./pages/UnderDevelopment";

const { Sider, Content } = Layout;

// ────────────────────────────────────────────────────────────
// 侧边菜单配置
// ────────────────────────────────────────────────────────────
const menuItems: MenuProps["items"] = [
  {
    key: "/todays-recommendation",
    label: "今日推荐",
  },
  {
    key: "/how-to-sell",
    label: "我的股票合适卖",
  },
];

// ────────────────────────────────────────────────────────────
// 主布局
// ────────────────────────────────────────────────────────────
export function App() {
  const navigate = useNavigate();
  const location = useLocation();

  // HashRouter 下 location.pathname 就是 hash 后的路径
  const selectedKey = location.pathname || "/todays-recommendation";

  const onMenuClick: MenuProps["onClick"] = ({ key }) => {
    navigate(key);
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="dark" width={200}>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={onMenuClick}
          style={{ height: "100%", borderRight: 0 }}
        />
      </Sider>

      <Layout>
        <Content style={{ background: "#fff" }}>
          <Routes>
            <Route path="/todays-recommendation" element={<TodaysRecommendation />} />
            {/* 我的股票合适卖页面路由（需求 1.1） */}
            <Route path="/how-to-sell" element={<HowToSell />} />
            <Route path="*" element={<UnderDevelopment />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default App;
