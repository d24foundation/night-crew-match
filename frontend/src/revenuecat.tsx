import React, { createContext, useContext, useEffect } from "react";
import { Platform } from "react-native";
import Purchases, { LOG_LEVEL } from "react-native-purchases";
import type { CustomerInfo, PurchasesPackage } from "react-native-purchases";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const REVENUECAT_TEST_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
const REVENUECAT_IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
const REVENUECAT_ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;

export const REVENUECAT_ENTITLEMENT_IDENTIFIER = "pro";
export const SUPER_PACKAGE_ID = "super_monthly";
export const PREMIUM_PACKAGE_ID = "$rc_monthly";
export const SUPER_ANNUAL_PACKAGE_ID = "super_annual";
export const PREMIUM_ANNUAL_PACKAGE_ID = "$rc_annual";

export const rcEnabled = Platform.OS !== "web" || __DEV__;
export const isTestStore = Platform.OS === "web" || __DEV__;

function getRevenueCatApiKey() {
  if (!REVENUECAT_TEST_API_KEY || !REVENUECAT_IOS_API_KEY || !REVENUECAT_ANDROID_API_KEY) {
    throw new Error("RevenueCat public API keys not found");
  }
  if (Platform.OS === "web" || __DEV__) return REVENUECAT_TEST_API_KEY;
  if (Platform.OS === "ios") return REVENUECAT_IOS_API_KEY;
  if (Platform.OS === "android") return REVENUECAT_ANDROID_API_KEY;
  return REVENUECAT_TEST_API_KEY;
}

export function initializeRevenueCat() {
  if (!rcEnabled) return;
  Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN);
  Purchases.configure({ apiKey: getRevenueCatApiKey() });
}

function useSubscriptionContext() {
  const queryClient = useQueryClient();
  const customerInfoQuery = useQuery({
    queryKey: ["revenuecat", "customer-info"],
    queryFn: () => Purchases.getCustomerInfo(),
    enabled: rcEnabled,
    staleTime: 60 * 1000,
  });
  const offeringsQuery = useQuery({
    queryKey: ["revenuecat", "offerings"],
    queryFn: () => Purchases.getOfferings(),
    enabled: rcEnabled,
    staleTime: 300 * 1000,
  });

  useEffect(() => {
    if (!rcEnabled) return;
    const listener = (info: CustomerInfo) => queryClient.setQueryData(["revenuecat", "customer-info"], info);
    Purchases.addCustomerInfoUpdateListener(listener);
    return () => {
      Purchases.removeCustomerInfoUpdateListener(listener);
    };
  }, [queryClient]);

  const purchaseMutation = useMutation({
    mutationFn: async (pkg: PurchasesPackage) => {
      const id = (await Purchases.getCustomerInfo()).originalAppUserId;
      if (id.startsWith("$RCAnonymousID:")) throw new Error("identity_not_ready");
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      return customerInfo;
    },
  });
  const restoreMutation = useMutation({ mutationFn: () => Purchases.restorePurchases() });

  const info = customerInfoQuery.data;
  const isSubscribed = info?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER] !== undefined;
  const packages = offeringsQuery.data?.current?.availablePackages ?? [];
  const superPkg = packages.find((p) => p.identifier === SUPER_PACKAGE_ID);
  const premiumPkg = packages.find((p) => p.identifier === PREMIUM_PACKAGE_ID);
  const superAnnualPkg = packages.find((p) => p.identifier === SUPER_ANNUAL_PACKAGE_ID);
  const premiumAnnualPkg = packages.find((p) => p.identifier === PREMIUM_ANNUAL_PACKAGE_ID);
  const activeProduct = info?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER]?.productIdentifier ?? "";
  const superProductIds = [superPkg, superAnnualPkg].filter(Boolean).map((p) => p!.product.identifier.split(":")[0]);
  const storeTier: "premium" | "super" | null = !isSubscribed
    ? null
    : superProductIds.some((id) => activeProduct.startsWith(id))
      ? "super"
      : "premium";
  const originalAppUserId = info?.originalAppUserId;
  const identityReady = !!originalAppUserId && !originalAppUserId.startsWith("$RCAnonymousID:");
  const willRenew = info?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER]?.willRenew ?? null;

  return {
    customerInfo: info,
    offerings: offeringsQuery.data,
    superPkg,
    premiumPkg,
    superAnnualPkg,
    premiumAnnualPkg,
    willRenew,
    isSubscribed,
    storeTier,
    identityReady,
    isLoading: customerInfoQuery.isLoading || offeringsQuery.isLoading,
    purchase: purchaseMutation.mutateAsync,
    restore: restoreMutation.mutateAsync,
    isPurchasing: purchaseMutation.isPending,
    isRestoring: restoreMutation.isPending,
  };
}

type SubscriptionContextValue = ReturnType<typeof useSubscriptionContext>;
const Context = createContext<SubscriptionContextValue | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const value = useSubscriptionContext();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSubscription() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useSubscription must be used within a SubscriptionProvider");
  return ctx;
}

// RevenueCat Customer Center: lets subscribers manage/cancel/refund themselves. Native store builds only.
export const customerCenterAvailable = Platform.OS !== "web" && !__DEV__;
export async function openCustomerCenter() {
  const RevenueCatUI = (await import("react-native-purchases-ui")).default;
  await RevenueCatUI.presentCustomerCenter();
}
