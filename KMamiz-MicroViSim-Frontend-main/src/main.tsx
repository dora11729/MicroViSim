import Config from "../Config";
import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom";
import "./index.css";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Header from "./components/Header";
import Loading from "./components/Loading";

const DependencyGraph = lazy(() => import("./pages/DependencyGraph"));
const Metrics = lazy(() => import("./pages/Metrics"));
const Insights = lazy(() => import("./pages/Insights"));
const Endpoints = lazy(() => import("./pages/Endpoints"));
const Interfaces = lazy(() => import("./pages/Interfaces"));
const Swagger = lazy(() => import("./pages/Swagger"));
const ComparatorHome = lazy(() => import("./pages/comparator/ComparatorHome"));

const Simulation = lazy(() => import("./pages/simulator/SimulatorHome"));

ReactDOM.render(
  <React.StrictMode>
    <BrowserRouter>
      <Header />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<DependencyGraph />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/endpoints" element={<Endpoints />} />
          <Route path="/interfaces" element={<Interfaces />} />
          <Route path="/swagger/:service" element={<Swagger />} />
          {!Config.backendConfig.SimulatorMode && (
            <Route path="/comparatorHome" element={<ComparatorHome />} />
          )}
          {Config.backendConfig.SimulatorMode && (
            <> 
              <Route path="/simulatorHome" element={<Simulation/>} /> 
            </>
          )}
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
  document.getElementById("root")
);
